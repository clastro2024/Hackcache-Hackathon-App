import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, readlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { types } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { APP_ROOT, isWithin, resolveDatabasePath } from './config.js';

export const SCHEMA_VERSION = 1;
export class StorageError extends Error {
  constructor(code, commitState = 'NOT_APPLIED') {
    super(code); this.code = code; this.commit_state = commitState;
  }
}
export const requireStorage = (condition, code) => { if (!condition) throw new StorageError(code); };
const json = (field, bytes = 8192) => `${field} TEXT NOT NULL CHECK(json_valid(${field}) AND length(CAST(${field} AS BLOB)) <= ${bytes})`;
const ver = 'INTEGER NOT NULL CHECK(version >= 0)';
const tables = {
  schema_meta: `singleton INTEGER PRIMARY KEY CHECK(singleton = 1), schema_version INTEGER NOT NULL CHECK(schema_version = 1),
    dataset_id TEXT NOT NULL UNIQUE, facility_id TEXT NOT NULL UNIQUE, seed_label TEXT NOT NULL, map_version TEXT NOT NULL,
    next_token_number INTEGER NOT NULL CHECK(next_token_number > 0), created_at INTEGER NOT NULL CHECK(created_at >= 0),
    restored_from_json TEXT CHECK(restored_from_json IS NULL OR json_valid(restored_from_json))`,
  patients: `patient_id TEXT PRIMARY KEY NOT NULL, display_name TEXT NOT NULL, date_of_birth TEXT,
    language TEXT NOT NULL CHECK(language IN ('hi','en')), demo_identifier TEXT, created_at INTEGER NOT NULL CHECK(created_at >= 0)`,
  accounts: `account_id TEXT PRIMARY KEY NOT NULL, username TEXT NOT NULL UNIQUE CHECK(username = lower(username)),
    role TEXT NOT NULL CHECK(role IN ('STAFF','CLINICIAN','PATIENT')), password_hash TEXT NOT NULL,
    patient_id TEXT REFERENCES patients(patient_id), ${json('room_ids_json')}, ${json('permissions_json')},
    registration_id TEXT, active INTEGER NOT NULL CHECK(active IN (0,1)), created_at INTEGER NOT NULL CHECK(created_at >= 0),
    CHECK((role = 'PATIENT' AND patient_id IS NOT NULL) OR (role != 'PATIENT' AND patient_id IS NULL)),
    CHECK(json_type(room_ids_json) = 'array' AND json_type(permissions_json) = 'array')`,
  rooms: `room_id TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL, floor TEXT NOT NULL, map_node TEXT NOT NULL,
    clinician_id TEXT NOT NULL REFERENCES accounts(account_id), service_state TEXT NOT NULL CHECK(service_state IN ('ACTIVE','PAUSED_ON_BREAK')),
    delay_reason TEXT, estimated_return_at INTEGER, version ${ver}`,
  visits: `visit_id TEXT PRIMARY KEY NOT NULL, patient_id TEXT NOT NULL REFERENCES patients(patient_id),
    token_id TEXT NOT NULL UNIQUE, public_token TEXT NOT NULL UNIQUE, room_id TEXT NOT NULL REFERENCES rooms(room_id),
    queue_state TEXT NOT NULL CHECK(queue_state IN ('WAITING','TRANSFERRED','RECALLED','IN_CONSULTATION','SKIPPED_ABSENT','COMPLETED','CANCELLED')),
    queue_rank INTEGER, ${json('intake_json')}, next_destination_json TEXT CHECK(next_destination_json IS NULL OR json_valid(next_destination_json)),
    created_at INTEGER NOT NULL CHECK(created_at >= 0), UNIQUE(visit_id, patient_id),
    CHECK((queue_state IN ('WAITING','TRANSFERRED','RECALLED') AND queue_rank IS NOT NULL AND queue_rank > 0) OR
      (queue_state NOT IN ('WAITING','TRANSFERRED','RECALLED') AND queue_rank IS NULL))`,
  encounters: `encounter_id TEXT PRIMARY KEY NOT NULL, visit_id TEXT NOT NULL, patient_id TEXT NOT NULL,
    room_id TEXT NOT NULL REFERENCES rooms(room_id), clinician_id TEXT NOT NULL REFERENCES accounts(account_id),
    called_at INTEGER NOT NULL CHECK(called_at >= 0), call_attempts INTEGER NOT NULL CHECK(call_attempts BETWEEN 1 AND 3),
    last_called_at INTEGER NOT NULL CHECK(last_called_at >= called_at), checked_in_at INTEGER,
    checked_in_by TEXT REFERENCES accounts(account_id), closed_at INTEGER, closure_reason TEXT,
    FOREIGN KEY(visit_id,patient_id) REFERENCES visits(visit_id,patient_id),
    UNIQUE(encounter_id,patient_id), UNIQUE(encounter_id,patient_id,clinician_id),
    CHECK((checked_in_at IS NULL AND checked_in_by IS NULL) OR (checked_in_at IS NOT NULL AND checked_in_at >= called_at AND checked_in_by IS NOT NULL)),
    CHECK((closed_at IS NULL AND closure_reason IS NULL) OR (closed_at IS NOT NULL AND closed_at >= last_called_at AND closure_reason IS NOT NULL AND
      (checked_in_at IS NULL OR closed_at >= checked_in_at)))`,
  sessions: `session_id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(account_id),
    secret_hash TEXT NOT NULL UNIQUE CHECK(length(secret_hash) = 64), csrf_value TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at >= 0), expires_at INTEGER NOT NULL,
    revoked_at INTEGER, UNIQUE(session_id,account_id),
    CHECK(expires_at > created_at AND expires_at - created_at <= 7200000),
    CHECK(revoked_at IS NULL OR revoked_at >= created_at)`,
  consent_requests: `request_id TEXT PRIMARY KEY NOT NULL, encounter_id TEXT NOT NULL, patient_id TEXT NOT NULL,
    clinician_id TEXT NOT NULL, clinician_session_id TEXT NOT NULL, facility_id TEXT NOT NULL REFERENCES schema_meta(facility_id),
    purpose TEXT NOT NULL CHECK(purpose = 'OPD_CONSULTATION'), ${json('scopes_json')}, explanation TEXT,
    state TEXT NOT NULL CHECK(state IN ('REQUESTED','CLARIFICATION_REQUESTED','ALLOWED','DENIED','EXPIRED','CANCELLED')),
    created_at INTEGER NOT NULL CHECK(created_at >= 0), expires_at INTEGER NOT NULL, version ${ver}, decision_at INTEGER,
    decision_actor_id TEXT REFERENCES accounts(account_id), approval_channel TEXT CHECK(approval_channel IN ('PHONE','ASSISTED_QR')),
    assistance_json TEXT CHECK(assistance_json IS NULL OR json_valid(assistance_json)), end_reason TEXT,
    FOREIGN KEY(encounter_id,patient_id,clinician_id) REFERENCES encounters(encounter_id,patient_id,clinician_id),
    FOREIGN KEY(clinician_session_id,clinician_id) REFERENCES sessions(session_id,account_id),
    CHECK(expires_at > created_at AND expires_at - created_at <= 300000), CHECK(json_type(scopes_json) = 'array'),
    CHECK(state NOT IN ('ALLOWED','DENIED') OR (decision_at IS NOT NULL AND decision_actor_id IS NOT NULL AND approval_channel IS NOT NULL))`,
  audit_events: `audit_id INTEGER PRIMARY KEY, actor_id TEXT REFERENCES accounts(account_id), patient_id TEXT REFERENCES patients(patient_id),
    encounter_id TEXT, operation TEXT NOT NULL, result TEXT NOT NULL, recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
    ${json('details_json',16384)}, FOREIGN KEY(encounter_id,patient_id) REFERENCES encounters(encounter_id,patient_id)`,
  encounter_grants: `grant_id TEXT PRIMARY KEY NOT NULL, request_id TEXT REFERENCES consent_requests(request_id),
    encounter_id TEXT NOT NULL, patient_id TEXT NOT NULL, clinician_id TEXT NOT NULL, clinician_session_id TEXT NOT NULL,
    facility_id TEXT NOT NULL REFERENCES schema_meta(facility_id), purpose TEXT NOT NULL CHECK(purpose = 'OPD_CONSULTATION'),
    ${json('scopes_json')}, mode TEXT NOT NULL CHECK(mode IN ('PATIENT_APPROVED','BREAK_GLASS')),
    state TEXT NOT NULL CHECK(state IN ('ACTIVE','EXPIRED','REVOKED','ENDED')), issued_at INTEGER NOT NULL CHECK(issued_at >= 0),
    expires_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT, authorization_event_id INTEGER NOT NULL REFERENCES audit_events(audit_id),
    version ${ver}, FOREIGN KEY(encounter_id,patient_id,clinician_id) REFERENCES encounters(encounter_id,patient_id,clinician_id),
    FOREIGN KEY(clinician_session_id,clinician_id) REFERENCES sessions(session_id,account_id),
    CHECK(expires_at > issued_at AND expires_at - issued_at <= 900000), CHECK(json_type(scopes_json) = 'array'),
    CHECK((mode = 'PATIENT_APPROVED' AND request_id IS NOT NULL) OR (mode = 'BREAK_GLASS' AND request_id IS NULL)),
    CHECK((state = 'ACTIVE' AND ended_at IS NULL AND end_reason IS NULL) OR
      (state != 'ACTIVE' AND ended_at IS NOT NULL AND ended_at >= issued_at AND end_reason IS NOT NULL))`,
  clinical_drafts: `draft_id TEXT PRIMARY KEY NOT NULL, encounter_id TEXT NOT NULL UNIQUE REFERENCES encounters(encounter_id),
    state TEXT NOT NULL CHECK(state IN ('DRAFT','REVIEWED','COMMITTED','DISCARDED')), version ${ver}, ${json('capture_json',131072)},
    reviewed_payload_hash TEXT, reviewed_by TEXT REFERENCES accounts(account_id), reviewed_at INTEGER,
    committed_event_ids_json TEXT CHECK(committed_event_ids_json IS NULL OR json_valid(committed_event_ids_json)),
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
    CHECK(state NOT IN ('REVIEWED','COMMITTED') OR (reviewed_payload_hash IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
    CHECK(state != 'COMMITTED' OR committed_event_ids_json IS NOT NULL)`,
  clinical_events: `event_id TEXT PRIMARY KEY NOT NULL, patient_id TEXT NOT NULL REFERENCES patients(patient_id), encounter_id TEXT,
    sequence INTEGER NOT NULL CHECK(sequence > 0), supersedes_event_id TEXT, ledger_format TEXT NOT NULL CHECK(ledger_format = 'v1'),
    ${json('event_json',65536)}, previous_hash TEXT NOT NULL, event_hash TEXT NOT NULL CHECK(length(event_hash) = 64),
    recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0), UNIQUE(patient_id,event_id),
    FOREIGN KEY(encounter_id,patient_id) REFERENCES encounters(encounter_id,patient_id),
    FOREIGN KEY(patient_id,supersedes_event_id) REFERENCES clinical_events(patient_id,event_id),
    CHECK(json_extract(event_json,'$.event_id') IS event_id AND json_extract(event_json,'$.patient_id') IS patient_id AND
      json_extract(event_json,'$.encounter_id') IS encounter_id AND json_extract(event_json,'$.sequence') IS sequence AND
      json_extract(event_json,'$.supersedes_event_id') IS supersedes_event_id AND json_extract(event_json,'$.ledger_format') IS ledger_format)`,
  mutation_receipts: `actor_id TEXT NOT NULL REFERENCES accounts(account_id), operation TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64), ${json('outcome_json',8192)},
    created_at INTEGER NOT NULL CHECK(created_at >= 0), PRIMARY KEY(actor_id,operation,idempotency_key)`,
};
export const schemaStatements = Object.entries(tables).map(([name, columns]) => `CREATE TABLE ${name} (${columns}) STRICT`);
schemaStatements.push(
  "CREATE UNIQUE INDEX uq_current_room ON visits(room_id) WHERE queue_state = 'IN_CONSULTATION'",
  "CREATE UNIQUE INDEX uq_waiting_rank ON visits(room_id,queue_rank) WHERE queue_state IN ('WAITING','TRANSFERRED','RECALLED')",
  'CREATE UNIQUE INDEX uq_open_visit ON encounters(visit_id) WHERE closed_at IS NULL',
  'CREATE UNIQUE INDEX uq_open_room ON encounters(room_id) WHERE closed_at IS NULL',
  "CREATE UNIQUE INDEX uq_pending_request ON consent_requests(encounter_id,clinician_session_id) WHERE state IN ('REQUESTED','CLARIFICATION_REQUESTED')",
  "CREATE UNIQUE INDEX uq_active_grant ON encounter_grants(encounter_id,clinician_session_id) WHERE state = 'ACTIVE'",
  'CREATE UNIQUE INDEX uq_patient_sequence ON clinical_events(patient_id,sequence)',
  'CREATE UNIQUE INDEX uq_direct_successor ON clinical_events(supersedes_event_id) WHERE supersedes_event_id IS NOT NULL',
  'CREATE INDEX ix_sessions_account ON sessions(account_id,expires_at)',
  'CREATE INDEX ix_requests_patient ON consent_requests(patient_id,state)',
  'CREATE INDEX ix_encounters_visit ON encounters(visit_id,called_at)',
  'CREATE INDEX ix_audit_patient ON audit_events(patient_id,audit_id)',
  'CREATE INDEX ix_events_encounter ON clinical_events(encounter_id,sequence)',
);
for (const [table, stem] of [['clinical_events','clinical'], ['audit_events','audit'], ['mutation_receipts','receipt']]) {
  for (const operation of ['UPDATE','DELETE']) schemaStatements.push(`CREATE TRIGGER ${stem}_no_${operation.toLowerCase()}
    BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'append_only'); END`);
}
schemaStatements.push(
  `CREATE TRIGGER clinical_no_replace BEFORE INSERT ON clinical_events WHEN EXISTS
    (SELECT 1 FROM clinical_events WHERE event_id = NEW.event_id OR (patient_id = NEW.patient_id AND sequence = NEW.sequence))
    BEGIN SELECT RAISE(ABORT,'append_only'); END`,
  `CREATE TRIGGER audit_no_replace BEFORE INSERT ON audit_events WHEN EXISTS
    (SELECT 1 FROM audit_events WHERE audit_id = NEW.audit_id) BEGIN SELECT RAISE(ABORT,'append_only'); END`,
  `CREATE TRIGGER receipt_no_replace BEFORE INSERT ON mutation_receipts WHEN EXISTS
    (SELECT 1 FROM mutation_receipts WHERE actor_id = NEW.actor_id AND operation = NEW.operation AND idempotency_key = NEW.idempotency_key)
    BEGIN SELECT RAISE(ABORT,'receipt_exists'); END`,
  `CREATE TRIGGER draft_terminal_no_update BEFORE UPDATE ON clinical_drafts WHEN OLD.state IN ('COMMITTED','DISCARDED')
    BEGIN SELECT RAISE(ABORT,'terminal_draft'); END`,
  `CREATE TRIGGER draft_terminal_no_delete BEFORE DELETE ON clinical_drafts WHEN OLD.state IN ('COMMITTED','DISCARDED')
    BEGIN SELECT RAISE(ABORT,'terminal_draft'); END`,
  `CREATE TRIGGER clinical_predecessor BEFORE INSERT ON clinical_events WHEN
    NEW.sequence != COALESCE((SELECT MAX(sequence)+1 FROM clinical_events WHERE patient_id = NEW.patient_id),1) OR
    NEW.previous_hash != COALESCE((SELECT event_hash FROM clinical_events WHERE patient_id = NEW.patient_id ORDER BY sequence DESC LIMIT 1),'GENESIS') OR
    (NEW.supersedes_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM clinical_events p WHERE p.event_id = NEW.supersedes_event_id AND
      p.patient_id = NEW.patient_id AND p.sequence < NEW.sequence AND json_extract(p.event_json,'$.entity_id') = json_extract(NEW.event_json,'$.entity_id') AND
      json_extract(p.event_json,'$.event_type') != 'RECORD_RETRACTED' AND (json_extract(NEW.event_json,'$.event_type') = 'RECORD_RETRACTED' OR
      json_extract(NEW.event_json,'$.event_type') = json_extract(p.event_json,'$.event_type'))))
    BEGIN SELECT RAISE(ABORT,'invalid_predecessor'); END`,
);
Object.freeze(schemaStatements);

export function privatePath(value, { createParents = false, existing = false } = {}) {
  const file = resolveDatabasePath(value);
  const data = path.join(APP_ROOT, 'data');
  const privateParts=path.relative(data,file).split(path.sep);
  requireStorage(privateParts.length>=2 && ['runtime','backups','reports','test-runs'].includes(privateParts[0]),'UNSAFE_PRIVATE_PATH');
  const pieces = path.relative(APP_ROOT, file).split(path.sep);
  let current = APP_ROOT;
  for (const [index, piece] of pieces.entries()) {
    current = path.join(current, piece);
    if (!existsSync(current)) {
      if (index < pieces.length - 1 && createParents) mkdirSync(current, { mode: 0o700 });
      else if (index < pieces.length - 1 || existing) throw new StorageError('FILE_NOT_FOUND');
      else break;
    }
    const entry = lstatSync(current);
    requireStorage(!entry.isSymbolicLink() && isWithin(APP_ROOT, realpathSync(current)), 'UNSAFE_PRIVATE_PATH');
    requireStorage(index === pieces.length - 1 ? entry.isFile() : entry.isDirectory(), 'UNSAFE_PRIVATE_PATH');
  }
  requireStorage(file !== data, 'UNSAFE_PRIVATE_PATH');
  return file;
}

function linuxProcessIdentity(pid) {
  if(process.platform!=='linux')return null;
  try {
    const stat=readFileSync(`/proc/${pid}/stat`,'utf8');
    const start=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/u)[19];
    if(!/^\d+$/u.test(start))return null;
    const identity={start_ticks:start};
    try {identity.boot_id=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();}catch{}
    try {identity.pid_namespace=readlinkSync(`/proc/${pid}/ns/pid`);}catch{}
    return identity;
  }catch{return null;}
}

// A Render disk has one instance at a time; PIDs from older instances are unrelated.
// All current-instance server/maintenance processes share the same scoped lease.
// Local files keep the original lease path. Live/unknown owners are never killed.
export function acquireLease(file) {
  const instance=process.env.RENDER==='true'?process.env.RENDER_INSTANCE_ID:null;
  requireStorage(instance===null || (typeof instance==='string'&&/^[A-Za-z0-9_-]{1,128}$/u.test(instance)), 'INVALID_RUNTIME_INSTANCE');
  const lock = instance?`${file}.${instance}.lock`:`${file}.lock`;
  const identity=linuxProcessIdentity(process.pid);
  requireStorage(!instance || identity!==null,'LEASE_IDENTITY_UNAVAILABLE');
  const token = JSON.stringify({ pid: process.pid, nonce: randomUUID(),...(identity?{identity}:{}) });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = openSync(lock, 'wx', 0o600);
      try { writeFileSync(handle, token); } finally { closeSync(handle); }
      return () => {
        if (existsSync(lock) && !lstatSync(lock).isSymbolicLink() && readFileSync(lock, 'utf8') === token) unlinkSync(lock);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat=lstatSync(lock);
      requireStorage(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 512, 'MAINTENANCE_LOCKED');
      let owner;
      try { owner = JSON.parse(readFileSync(lock, 'utf8')); } catch { throw new StorageError('MAINTENANCE_LOCKED'); }
      requireStorage(Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.nonce === 'string', 'MAINTENANCE_LOCKED');
      let dead = false;
      try { process.kill(owner.pid, 0); } catch (failure) { dead = failure.code === 'ESRCH'; }
      if(!dead && owner.identity && /^\d+$/u.test(owner.identity.start_ticks ?? '')) {
        const actual=linuxProcessIdentity(owner.pid);
        if(actual)dead=actual.start_ticks!==owner.identity.start_ticks ||
          ['boot_id','pid_namespace'].some(key=>typeof owner.identity[key]==='string'&&typeof actual[key]==='string'&&owner.identity[key]!==actual[key]);
      }
      requireStorage(dead, 'MAINTENANCE_LOCKED');
      // Do not unlink a lease replaced since it was inspected.
      if (readFileSync(lock, 'utf8') === JSON.stringify(owner)) unlinkSync(lock);
    }
  }
  throw new StorageError('MAINTENANCE_LOCKED');
}

export function configureConnection(db) {
  const version = db.prepare('SELECT sqlite_version() AS version').get().version.split('.').map(Number);
  requireStorage(version[0] > 3 || (version[0] === 3 && (version[1] > 51 ||
    (version[1] === 51 && version[2] >= 3))), 'UNSUPPORTED_SQLITE');
  db.pragma('foreign_keys = ON'); db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 50'); db.pragma('wal_autocheckpoint = 1000'); db.pragma('recursive_triggers = ON');
}

export function createStore(db, release = () => {}) {
  let writing = false;
  let closed = false;
  const store = {
    db,
    get inWriteUnit() { return writing && db.inTransaction; },
    close() { if (!closed) { db.close(); closed = true; release(); } },
    runUnit(write, work) {
      requireStorage(!closed && !db.inTransaction, 'NESTED_OR_CLOSED_UNIT');
      requireStorage(typeof work === 'function' && !types.isAsyncFunction(work), 'ASYNC_UNIT_REJECTED');
      let phase = 'BEGIN';
      let poison = false;
      try {
        db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN'); writing = write; phase = 'WORK';
        const result = work();
        if (result && typeof result.then === 'function') {
          poison = true;
          Promise.resolve(result).catch(() => {});
          throw new StorageError('ASYNC_UNIT_REJECTED');
        }
        requireStorage(db.inTransaction, 'TRANSACTION_BOUNDARY_VIOLATION');
        phase = 'COMMIT'; db.exec('COMMIT'); return result;
      } catch (error) {
        let rolledBack = phase === 'BEGIN';
        if (db.inTransaction) {
          try { db.exec('ROLLBACK'); rolledBack = !db.inTransaction; } catch { poison = true; }
        } else if (phase === 'WORK' && error.code !== 'TRANSACTION_BOUNDARY_VIOLATION') rolledBack = true;
        error.commit_state = rolledBack ? 'NOT_APPLIED' : 'UNKNOWN';
        if (!rolledBack) poison = true;
        if (poison) store.close();
        throw error;
      } finally { writing = false; }
    },
  };
  return store;
}

export async function retryUnit(store, write, work, { clock = () => performance.now(), sleep = delay,
  random = Math.random } = {}) {
  const deadline = clock() + 5000;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return store.runUnit(write, work); } catch (error) {
      if (!/^SQLITE_(BUSY|LOCKED)(_|$)/u.test(error.code ?? '') || error.commit_state !== 'NOT_APPLIED') throw error;
      const wait = Math.floor(random() * (attempt === 0 ? 251 : 501));
      if (attempt === 2 || clock() + wait + 50 >= deadline) throw new StorageError('EDGE_BUSY');
      await sleep(wait); // after rollback; next attempt reruns the complete callback.
    }
  }
}

const normalizeSQL = sql => sql.trim().replace(/;$/u, '').replace(/\s+/gu, ' ');
export function verifyStorage(db, { journal = 'wal', now = Date.now() } = {}) {
  for (const [name, expected] of [['foreign_keys',1], ['synchronous',2], ['busy_timeout',50],
    ['wal_autocheckpoint',1000], ['recursive_triggers',1], ['journal_mode',journal]]) {
    requireStorage(db.pragma(name, { simple: true }) === expected, 'INVALID_DATABASE_SETTINGS');
  }
  requireStorage(db.pragma('user_version', { simple: true }) === SCHEMA_VERSION, 'UNSUPPORTED_SCHEMA');
  requireStorage(db.pragma('integrity_check', { simple: true }) === 'ok' &&
    db.pragma('foreign_key_check').length === 0, 'DATABASE_INTEGRITY_INVALID');
  const actual = db.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all();
  requireStorage(actual.length === schemaStatements.length && schemaStatements.every(sql => {
    const name = /^CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER) (\w+)/u.exec(sql)[1];
    return actual.some(row => row.name === name && normalizeSQL(row.sql) === normalizeSQL(sql));
  }), 'SCHEMA_DEFINITION_MISMATCH');
  const meta = db.prepare('SELECT * FROM schema_meta WHERE singleton = 1').get();
  requireStorage(meta?.schema_version === 1 && meta.seed_label === 'opd-demo-v1', 'UNSUPPORTED_DATASET');
  requireStorage([meta.dataset_id,meta.facility_id,meta.map_version].every(value=>typeof value==='string' &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(value)), 'UNSUPPORTED_DATASET');
  const count = sql => db.prepare(sql).get().n;
  requireStorage(count(`SELECT COUNT(*) n FROM rooms r JOIN accounts a ON a.account_id = r.clinician_id WHERE a.role != 'CLINICIAN'`) === 0,
    'INVALID_ACCOUNT_BINDING');
  requireStorage(count(`SELECT COUNT(*) n FROM visits v LEFT JOIN encounters e ON e.visit_id = v.visit_id AND e.closed_at IS NULL
    WHERE (v.queue_state = 'IN_CONSULTATION' AND (e.encounter_id IS NULL OR e.room_id != v.room_id OR e.patient_id != v.patient_id)) OR
      (v.queue_state != 'IN_CONSULTATION' AND e.encounter_id IS NOT NULL)`) === 0, 'INVALID_QUEUE_BINDING');
  requireStorage(count(`SELECT COUNT(*) n FROM encounters e JOIN rooms r ON r.room_id=e.room_id JOIN accounts a ON a.account_id=e.clinician_id
    WHERE a.role != 'CLINICIAN' OR (e.closed_at IS NULL AND e.clinician_id != r.clinician_id)`) === 0, 'INVALID_ACCOUNT_BINDING');
  for (const room of db.prepare('SELECT room_id FROM rooms').all()) {
    const ranks = db.prepare('SELECT queue_rank FROM visits WHERE room_id=? AND queue_rank IS NOT NULL ORDER BY queue_rank').all(room.room_id);
    requireStorage(ranks.every((r,i) => r.queue_rank === i + 1), 'INVALID_QUEUE_RANKS');
    requireStorage(db.prepare("SELECT COUNT(*) n FROM visits WHERE room_id=? AND queue_state NOT IN ('COMPLETED','CANCELLED')").get(room.room_id).n <= 100,
      'QUEUE_CAPACITY_EXCEEDED');
  }
  requireStorage(count(`SELECT COUNT(*) n FROM consent_requests q JOIN sessions s ON s.session_id=q.clinician_session_id
    JOIN encounters e ON e.encounter_id=q.encounter_id WHERE q.expires_at > s.expires_at OR q.created_at < s.created_at OR
    (q.state IN ('REQUESTED','CLARIFICATION_REQUESTED') AND (e.closed_at IS NOT NULL OR e.checked_in_at IS NULL OR s.revoked_at IS NOT NULL))`) === 0,
  'INVALID_AUTHORIZATION_BINDING');
  requireStorage(count(`SELECT COUNT(*) n FROM encounter_grants g JOIN sessions s ON s.session_id=g.clinician_session_id
    JOIN encounters e ON e.encounter_id=g.encounter_id LEFT JOIN consent_requests q ON q.request_id=g.request_id
    JOIN audit_events a ON a.audit_id=g.authorization_event_id WHERE g.expires_at > s.expires_at OR g.issued_at < s.created_at OR
    a.patient_id IS NOT g.patient_id OR a.encounter_id IS NOT g.encounter_id OR
    (g.state='ACTIVE' AND (e.closed_at IS NOT NULL OR e.checked_in_at IS NULL OR s.revoked_at IS NOT NULL)) OR
    (g.mode='PATIENT_APPROVED' AND (q.state IS NOT 'ALLOWED' OR q.encounter_id != g.encounter_id OR q.patient_id != g.patient_id OR
    q.clinician_id != g.clinician_id OR q.clinician_session_id != g.clinician_session_id OR q.purpose != g.purpose OR q.scopes_json != g.scopes_json))`) === 0,
  'INVALID_AUTHORIZATION_BINDING');
  for (const table of ['consent_requests','encounter_grants']) {
    for (const row of db.prepare(`SELECT scopes_json FROM ${table}`).all()) {
      let values;
      try { values=JSON.parse(row.scopes_json); } catch { throw new StorageError('INVALID_AUTHORIZATION_BINDING'); }
      requireStorage(Array.isArray(values) && values.length>0 && values.length<=5 && new Set(values).size===values.length &&
        values.every(value=>['triage:read','vault:query','affirmation:run','summary:export','vault:read'].includes(value)),
      'INVALID_AUTHORIZATION_BINDING');
    }
  }
  const latest = db.prepare(`SELECT MAX(t) t FROM (SELECT MAX(recorded_at) t FROM audit_events UNION ALL
    SELECT MAX(created_at) FROM sessions UNION ALL SELECT MAX(issued_at) FROM encounter_grants UNION ALL
    SELECT MAX(updated_at) FROM clinical_drafts UNION ALL SELECT MAX(recorded_at) FROM clinical_events UNION ALL
    SELECT MAX(created_at) FROM schema_meta UNION ALL SELECT MAX(created_at) FROM patients UNION ALL
    SELECT MAX(created_at) FROM accounts UNION ALL SELECT MAX(created_at) FROM visits UNION ALL
    SELECT MAX(last_called_at) FROM encounters UNION ALL SELECT MAX(checked_in_at) FROM encounters UNION ALL
    SELECT MAX(closed_at) FROM encounters UNION ALL SELECT MAX(created_at) FROM consent_requests UNION ALL
    SELECT MAX(decision_at) FROM consent_requests UNION ALL SELECT MAX(ended_at) FROM encounter_grants UNION ALL
    SELECT MAX(revoked_at) FROM sessions UNION ALL SELECT MAX(created_at) FROM mutation_receipts)`).get().t;
  requireStorage(Number.isSafeInteger(now) && now >= latest, 'TIME_UNTRUSTED');
  const counts = Object.fromEntries(Object.keys(tables).map(name => [name, count(`SELECT COUNT(*) n FROM ${name}`)]));
  return { schema_version: 1, dataset_id: meta.dataset_id, facility_id: meta.facility_id, seed_label: meta.seed_label,
    map_version: meta.map_version, counts, last_audit_id: db.prepare('SELECT MAX(audit_id) n FROM audit_events').get().n ?? 0 };
}

export function openDatabase(value, { verifyClinical, journal = 'wal', now = Date.now() } = {}) {
  requireStorage(typeof verifyClinical === 'function' && !types.isAsyncFunction(verifyClinical), 'CLINICAL_VERIFIER_REQUIRED');
  const file = privatePath(value, { existing: true });
  const release = acquireLease(file);
  let db;
  try {
    db = new Database(file, { fileMustExist: true, timeout: 50 });
    configureConnection(db);
    const store = createStore(db, release);
    store.verification = store.runUnit(false, () => {
      const verified=verifyStorage(db,{journal,now});const heads=verifyClinical(db);
      requireStorage(!heads || typeof heads.then!=='function','ASYNC_UNIT_REJECTED');
      return {...verified,clinical_heads:heads};
    });
    return store;
  } catch (error) { if (db?.open) db.close(); release(); throw error; }
}
