import { z } from 'zod';
import { auditDetailsSchema, receiptOutcomeSchema, id, hash, integer, text } from '../schemas.js';
import { StorageError, requireStorage } from '../db.js';
import { canonicalJSON, digest, parseJSON } from './vault.js';

const label = z.string().regex(/^[A-Z][A-Z0-9_:.-]{0,63}$/u);
const auditSchema = z.strictObject({ actor_id: id.nullable(), patient_id: id.nullable(), encounter_id: id.nullable(),
  operation: label, result: label, recorded_at: integer, details: auditDetailsSchema })
  .refine(value=>value.encounter_id===null || value.patient_id!==null);
const keySchema = z.strictObject({ actor_id: id, operation: text(160), idempotency_key: z.uuid(), request_fingerprint: hash });

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

// Self-audit download authorization and final audited release remain a later stage.
