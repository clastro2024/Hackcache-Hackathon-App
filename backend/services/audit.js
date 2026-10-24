import { z } from 'zod';
import { auditDetailsSchema, receiptOutcomeSchema, id, hash, integer, text, ApiError } from '../schemas.js';
import { StorageError, requireStorage } from '../db.js';
import { canonicalJSON, digest, parseJSON, verifyPatient } from './vault.js';

const label = z.string().regex(/^[A-Z][A-Z0-9_:.-]{0,63}$/u);
const auditSchema = z.strictObject({ actor_id: id.nullable(), patient_id: id.nullable(), encounter_id: id.nullable(),
  operation: label, result: label, recorded_at: integer, details: auditDetailsSchema })
  .refine(value=>value.encounter_id===null || value.patient_id!==null);
const keySchema = z.strictObject({ actor_id: id, operation: text(256), idempotency_key: z.uuid(), request_fingerprint: hash });

export function appendAudit(store, input) {
  requireStorage(store.inWriteUnit, 'WRITE_UNIT_REQUIRED');
  const value = auditSchema.parse(input);
  try {
    const result = store.db.prepare(`INSERT INTO audit_events(actor_id,patient_id,encounter_id,operation,result,recorded_at,details_json)
      VALUES(?,?,?,?,?,?,?)`).run(value.actor_id, value.patient_id, value.encounter_id, value.operation,
      value.result, value.recorded_at, canonicalJSON(value.details));
    return Number(result.lastInsertRowid);
  } catch { throw new StorageError('AUDIT_UNAVAILABLE'); }
}

export function fingerprint(intent) { return digest(canonicalJSON(intent)); }

// Caller must check current authorization BEFORE this helper; no authorization is conferred here.
export function findReceipt(store, input) {
  requireStorage(store.db.inTransaction, 'UNIT_REQUIRED');
  const key = keySchema.parse(input);
  const row = store.db.prepare(`SELECT request_fingerprint,outcome_json,created_at FROM mutation_receipts
    WHERE actor_id=? AND operation=? AND idempotency_key=?`).get(key.actor_id, key.operation, key.idempotency_key);
  if (!row) return null;
  if (row.request_fingerprint !== key.request_fingerprint) throw new StorageError('IDEMPOTENCY_CONFLICT');
  return { outcome: receiptOutcomeSchema.parse(parseJSON(row.outcome_json,8192)), created_at: row.created_at };
}

export function putReceipt(store, input, outcome, now) {
  requireStorage(store.inWriteUnit, 'WRITE_UNIT_REQUIRED');
  const key = keySchema.parse(input);
  const safe = receiptOutcomeSchema.parse(outcome);
  integer.parse(now);
  store.db.prepare(`INSERT INTO mutation_receipts(actor_id,operation,idempotency_key,request_fingerprint,outcome_json,created_at)
    VALUES(?,?,?,?,?,?)`).run(key.actor_id,key.operation,key.idempotency_key,key.request_fingerprint,canonicalJSON(safe),now);
  return safe;
}

export function patientAuditHead(store,patientId) {
  requireStorage(store.db.inTransaction,'UNIT_REQUIRED');
  return store.db.prepare('SELECT COALESCE(MAX(audit_id),0) n FROM audit_events WHERE patient_id=?').get(patientId).n;
}
export function auditSnapshot(store,patientId,{through,after=0,limit}={}) {
  requireStorage(store.db.inTransaction,'UNIT_REQUIRED');
  id.parse(patientId);integer.parse(through);integer.parse(after);
  if(!limit) {
    // Lower bound on actual JSON size before materializing a complete dossier. No truncation.
    const minimum=store.db.prepare('SELECT COALESCE(SUM(length(CAST(details_json AS BLOB))+80),0) n FROM audit_events WHERE patient_id=? AND audit_id<=?').get(patientId,through).n;
    if(minimum>1048576) throw new ApiError('EXPORT_TOO_LARGE');
  }
  const rows=store.db.prepare(`SELECT * FROM audit_events WHERE patient_id=? AND audit_id>? AND audit_id<=? ORDER BY audit_id${limit?' LIMIT ?':''}`)
    .all(...[patientId,after,through,...(limit?[integer.min(1).max(100).parse(limit)]:[])]);
  try {
    return rows.map(row=>({audit_id:row.audit_id,...auditSchema.parse({actor_id:row.actor_id,patient_id:row.patient_id,encounter_id:row.encounter_id,
      operation:row.operation,result:row.result,recorded_at:row.recorded_at,details:parseJSON(row.details_json,16384)})}));
  } catch {throw new StorageError('AUDIT_SOURCE_INVALID');}
}
export function patientIntegrity(store,patientId,time) {
  requireStorage(store.db.inTransaction,'UNIT_REQUIRED');
  const facility=store.db.prepare('SELECT facility_id FROM schema_meta WHERE singleton=1').get().facility_id;
  const count=store.db.prepare('SELECT COUNT(*) n FROM clinical_events WHERE patient_id=?').get(patientId).n;
  const base={ledger_format:'v1',patient_id:patientId,event_count:count,verified_at:new Date(time).toISOString(),
    limitation:'Hash consistency is tamper evidence, not source truth, a signature or an independent integrity anchor.'};
  try {
    const verified=verifyPatient(store.db,patientId,facility);
    return {...base,status:'PASS',checked_through_sequence:verified.checked_events,head_hash:verified.head_hash,
      integrity_status:'VALID',checked_events:verified.checked_events};
  } catch(error) {
    if(error.code!=='CLINICAL_INTEGRITY_INVALID') throw error;
    return {...base,status:'FAIL',checked_through_sequence:Math.max(0,(error.failure_sequence ?? 1)-1),
      first_failure_sequence:error.failure_sequence ?? null,reason_code:'CANONICAL_CHAIN_MISMATCH',head_hash:null,integrity_status:'INVALID'};
  }
}
