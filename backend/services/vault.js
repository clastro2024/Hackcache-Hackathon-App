import { createHash } from 'node:crypto';
import { eventSchema } from '../schemas.js';

export function vaultError(code) { return Object.assign(new Error(code), { code }); }
const fail = () => { throw vaultError('CLINICAL_INTEGRITY_INVALID'); };

// Bounded parser before Zod: JSON.parse alone discards duplicate object keys.
export function parseJSON(input, maxBytes = 131072) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > maxBytes) throw vaultError('INVALID_JSON');
  let position = 0;
  let nodes = 0;
  const bad = () => { throw vaultError('INVALID_JSON'); };
  const space = () => { while (/[\x20\t\r\n]/u.test(input[position] ?? '') && position < input.length) position += 1; };
  function string() {
    const start = position++;
    while (position < input.length) {
      const char = input[position++];
      if (char === '\\') position += 1;
      else if (char === '"') {
        try { return JSON.parse(input.slice(start, position)); } catch { bad(); }
      }
    }
    return bad();
  }
  function value(depth) {
    if (depth > 32 || ++nodes > 10000) bad();
    space();
    const char = input[position];
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      position += 1;
      const object = char === '{';
      const result = object ? Object.create(null) : [];
      const end = object ? '}' : ']';
      const keys = new Set();
      space();
      if (input[position] === end) { position += 1; return result; }
      while (position < input.length) {
        space();
        if (object) {
          if (input[position] !== '"') bad();
          const key = string();
          if (keys.has(key)) bad();
          keys.add(key);
          space();
          if (input[position++] !== ':') bad();
          result[key] = value(depth + 1);
        } else result.push(value(depth + 1));
        space();
        const next = input[position++];
        if (next === end) return result;
        if (next !== ',') bad();
      }
      return bad();
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]]) {
      if (input.startsWith(token, position)) { position += token.length; return result; }
    }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(input.slice(position))?.[0];
    if (!token) bad();
    position += token.length;
    const number = Number(token);
    if (!Number.isFinite(number) || (!/[.eE]/u.test(token) && !Number.isSafeInteger(number))) bad();
    return number;
  }
  const result = value(0);
  space();
  if (position !== input.length) bad();
  return result;
}

function compareKeys(a, b) {
  const left = [...a].map(c => c.codePointAt(0));
  const right = [...b].map(c => c.codePointAt(0));
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

export function pythonFloat(number) {
  if (!Number.isFinite(number)) throw vaultError('INVALID_CANONICAL_VALUE');
  if (Object.is(number, -0)) return '-0.0';
  const [mantissa, rawExponent] = number.toExponential().split('e');
  const exponent = Number(rawExponent);
  if (exponent < -4 || exponent >= 16) {
    return `${mantissa}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }
  return Number.isInteger(number) ? `${number}.0` : String(number);
}

// Python sort_keys/ensure_ascii=False/compact v1, not RFC 8785.
// The typed envelope has an integer sequence and nullable float capture.confidence.
export function canonicalJSON(value, trail = [], depth = 0) {
  if (depth > 32) throw vaultError('INVALID_CANONICAL_VALUE');
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') {
    if ([...value].some(c => c.codePointAt(0) >= 0xd800 && c.codePointAt(0) <= 0xdfff)) {
      throw vaultError('INVALID_CANONICAL_VALUE');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (trail.join('.') === 'capture.confidence' || !Number.isInteger(value) || Object.is(value, -0)) return pythonFloat(value);
    if (!Number.isSafeInteger(value)) throw vaultError('INVALID_CANONICAL_VALUE');
    return String(value);
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw vaultError('INVALID_CANONICAL_VALUE');
    return `[${value.map((child, index) => canonicalJSON(child, [...trail, String(index)], depth + 1)).join(',')}]`;
  }
  if (value && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    if(Object.getOwnPropertySymbols(value).length) throw vaultError('INVALID_CANONICAL_VALUE');
    return `{${Object.keys(value).sort(compareKeys).map(key =>
      `${canonicalJSON(key)}:${canonicalJSON(value[key], [...trail, key], depth + 1)}`).join(',')}}`;
  }
  throw vaultError('INVALID_CANONICAL_VALUE');
}

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function eventHash(previous, canonical) {
  if (previous !== 'GENESIS' && !/^[a-f0-9]{64}$/u.test(previous)) fail();
  return digest(Buffer.concat([Buffer.from(`${previous}|`, 'ascii'), Buffer.from(canonical, 'utf8')]));
}

function validateThread(event, threads, seen) {
  const prior = threads.get(event.entity_id);
  if (event.change_kind === 'INITIAL') {
    if (prior) fail();
  } else if (!prior || prior.event_type === 'RECORD_RETRACTED' ||
    prior.event_id !== event.supersedes_event_id || !seen.has(event.supersedes_event_id) ||
    (event.event_type !== 'RECORD_RETRACTED' && prior.event_type !== event.event_type)) fail();
  threads.set(event.entity_id, event);
  seen.add(event.event_id);
}

export function verifyPatient(db, patientId, facilityId) {
  const rows = db.prepare('SELECT *,CAST(event_json AS BLOB) AS event_bytes FROM clinical_events WHERE patient_id = ? ORDER BY sequence').all(patientId);
  let previous = 'GENESIS';
  const threads = new Map();
  const seen = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    let event;
    try { event = eventSchema.parse(parseJSON(row.event_json, 65536)); } catch { fail(); }
    if (canonicalJSON(event) !== row.event_json || !Buffer.from(row.event_json,'utf8').equals(row.event_bytes) || event.facility_id !== facilityId ||
      event.sequence !== index + 1 || row.previous_hash !== previous ||
      eventHash(previous, row.event_json) !== row.event_hash || Date.parse(event.recorded_at) !== row.recorded_at ||
      ['event_id', 'patient_id', 'encounter_id', 'sequence', 'supersedes_event_id', 'ledger_format']
        .some(key => event[key] !== row[key])) fail();
    if (event.capture.method !== 'FIXTURE_SEED') {
      const encounter = db.prepare('SELECT * FROM encounters WHERE encounter_id = ?').get(event.encounter_id);
      const author = db.prepare('SELECT role FROM accounts WHERE account_id = ?').get(event.recorded_by);
      if (!encounter || encounter.patient_id !== patientId || encounter.clinician_id !== event.recorded_by ||
        author?.role !== 'CLINICIAN') fail();
    }
    validateThread(event, threads, seen);
    previous = row.event_hash;
  }
  return { patient_id: patientId, checked_events: rows.length, head_hash: previous };
}

export function verifyChains(db) {
  const facility = db.prepare('SELECT facility_id FROM schema_meta WHERE singleton = 1').get()?.facility_id;
  if (!facility) fail();
  return db.prepare('SELECT patient_id FROM patients ORDER BY patient_id').all()
    .map(row => verifyPatient(db, row.patient_id, facility));
}

// Storage primitive only. Live writes remain unavailable until exact reviewed commit exists.
export function appendEvents(store, values, { fixtureSeed = false } = {}) {
  if (!store.inWriteUnit) throw vaultError('WRITE_UNIT_REQUIRED');
  if (!fixtureSeed) throw vaultError('REVIEWED_COMMIT_REQUIRED');
  if (!Array.isArray(values) || values.length < 1 || values.length > 20) throw vaultError('INVALID_EVENT_BATCH');
  const db = store.db;
  const facility = db.prepare('SELECT facility_id FROM schema_meta WHERE singleton = 1').get().facility_id;
  const patientId = values[0].patient_id;
  const head = verifyPatient(db, patientId, facility);
  const existing = db.prepare('SELECT event_json FROM clinical_events WHERE patient_id = ? ORDER BY sequence').all(patientId);
  const threads = new Map();
  const seen = new Set();
  for (const row of existing) validateThread(parseJSON(row.event_json), threads, seen);
  const batchEntities = new Set();
  let previous = head.head_hash;
  return values.map((value, index) => {
    const event = eventSchema.parse(value);
    if (event.capture.method !== 'FIXTURE_SEED' || event.patient_id !== patientId || event.facility_id !== facility ||
      event.sequence !== head.checked_events + index + 1 || batchEntities.has(event.entity_id) ||
      values.some(other => other.event_id === event.supersedes_event_id)) fail();
    batchEntities.add(event.entity_id);
    validateThread(event, threads, seen);
    const canonical = canonicalJSON(event);
    if (Buffer.byteLength(canonical) > 65536) throw vaultError('EVENT_TOO_LARGE');
    const hashed = eventHash(previous, canonical);
    db.prepare(`INSERT INTO clinical_events(event_id, patient_id, encounter_id, sequence, supersedes_event_id,
      ledger_format, event_json, previous_hash, event_hash, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.event_id, event.patient_id, event.encounter_id, event.sequence, event.supersedes_event_id,
        event.ledger_format, canonical, previous, hashed, Date.parse(event.recorded_at));
    previous = hashed;
    return event.event_id;
  });
}

// Entity projection, evidence answers and protected clinical release remain pending.
