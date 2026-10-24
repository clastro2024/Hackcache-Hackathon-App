import { createHash, randomUUID } from 'node:crypto';
import { eventSchema, ApiError, topics } from '../schemas.js';

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
export const termFamilies=Object.freeze({MEDICATION_RECORDED:['ecosprin_demo','metformin_demo','telmisartan_demo'],
  CONDITION_RECORDED:['type2_diabetes_demo','renal_impairment_demo','mental_health_demo','dyspepsia_demo'],
  ALLERGY_RECORDED:['penicillin_demo','latex_demo'],PROCEDURE_RECORDED:['cholecystectomy_demo']});
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
    try {
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
    } catch(error) {
      if(error.code==='CLINICAL_INTEGRITY_INVALID') error.failure_sequence=index+1;
      throw error;
    }
  }
  return { patient_id: patientId, checked_events: rows.length, head_hash: previous };
}

export function verifyChains(db) {
  const facility = db.prepare('SELECT facility_id FROM schema_meta WHERE singleton = 1').get()?.facility_id;
  if (!facility) fail();
  return db.prepare('SELECT patient_id FROM patients ORDER BY patient_id').all()
    .map(row => verifyPatient(db, row.patient_id, facility));
}

// Fixture storage primitive; live writes use the persisted reviewed draft entry below.
export function appendEvents(store, values, { fixtureSeed = false } = {}) {
  if (!store.inWriteUnit) throw vaultError('WRITE_UNIT_REQUIRED');
  if (!fixtureSeed) throw vaultError('REVIEWED_COMMIT_REQUIRED');
  if(values.some(value=>value.capture?.method!=='FIXTURE_SEED')) fail();
  return appendBatch(store,values);
}
function appendBatch(store,values) {
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
    if (event.patient_id !== patientId || event.facility_id !== facility ||
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

export function reviewedEvent(item,capture,{encounter,actorId,facilityId,reviewedAt,time,sequence,eventId}) {
  return {...item,ledger_format:'v1',event_id:eventId,patient_id:encounter.patient_id,encounter_id:encounter.encounter_id,
    facility_id:facilityId,sequence,recorded_by:actorId,recorded_at:new Date(time).toISOString(),synthetic:true,
    capture:{method:capture.input_mode==='MANUAL_TEXT'?'MANUAL':'MOCK_ASR',fixture_id:capture.fixture_id,
      extractor_version:capture.input_mode==='MANUAL_TEXT'?null:capture.extractor_version,confidence:null},
    review:{status:'CLINICIAN_REVIEWED',reviewed_by:actorId,reviewed_at:new Date(reviewedAt).toISOString()}};
}

// The only live append entry accepts a persisted, exact reviewed draft, never caller event bodies.
export function appendReviewedDraft(store,draftId,actorId,time) {
  if(!store.inWriteUnit) throw vaultError('WRITE_UNIT_REQUIRED');
  const row=store.db.prepare('SELECT * FROM clinical_drafts WHERE draft_id=?').get(draftId);
  if(!row || row.state!=='REVIEWED' || row.reviewed_by!==actorId || digest(row.capture_json)!==row.reviewed_payload_hash) fail();
  const encounter=store.db.prepare('SELECT * FROM encounters WHERE encounter_id=?').get(row.encounter_id);
  if(!encounter || encounter.closed_at!==null || encounter.checked_in_at===null || encounter.clinician_id!==actorId) fail();
  const capture=parseJSON(row.capture_json);if(canonicalJSON(capture)!==row.capture_json) fail();
  const facilityId=store.db.prepare('SELECT facility_id FROM schema_meta WHERE singleton=1').get().facility_id;
  const head=verifyPatient(store.db,encounter.patient_id,facilityId);
  const values=capture.items.map((item,index)=>reviewedEvent(item,capture,{encounter,actorId,facilityId,
    reviewedAt:row.reviewed_at,time,sequence:head.checked_events+index+1,eventId:`evt_${randomUUID()}`}));
  const ids=appendBatch(store,values);
  const final=store.db.prepare('SELECT sequence,event_hash FROM clinical_events WHERE event_id=?').get(ids.at(-1));
  return {event_ids:ids,first_sequence:head.checked_events+1,last_sequence:final.sequence,head_hash:final.event_hash};
}

export function clinicalSource(store,patientId,asOf) {
  const facility=store.db.prepare('SELECT facility_id FROM schema_meta WHERE singleton=1').get().facility_id;
  let head;
  try {head=verifyPatient(store.db,patientId,facility);} catch {throw new ApiError('CLINICAL_INTEGRITY_INVALID');}
  const sequence=asOf ?? head.checked_events;
  if(!Number.isSafeInteger(sequence) || sequence<0 || sequence>head.checked_events) throw new ApiError('VALIDATION_ERROR');
  const rows=store.db.prepare('SELECT event_json,previous_hash,event_hash FROM clinical_events WHERE patient_id=? AND sequence<=? ORDER BY sequence').all(patientId,sequence);
  return {patient_id:patientId,as_of_sequence:sequence,head_hash:rows.at(-1)?.event_hash ?? 'GENESIS',
    rows:rows.map(row=>({event:parseJSON(row.event_json,65536),previous_hash:row.previous_hash,event_hash:row.event_hash}))};
}
export function project(source,time) {
  const threads=new Map();
  for(const {event} of source.rows) {
    const old=threads.get(event.entity_id);
    threads.set(event.entity_id,{root_sequence:old?.root_sequence ?? event.sequence,event});
  }
  const data={medications:[],conditions:[],allergies:[],procedures:[],negative_findings:[],warnings:[]};
  const groups={MEDICATION_RECORDED:'medications',CONDITION_RECORDED:'conditions',ALLERGY_RECORDED:'allergies',
    PROCEDURE_RECORDED:'procedures',NEGATIVE_FINDING_RECORDED:'negative_findings'};
  const names=new Set();
  for(const {event} of [...threads.values()].sort((a,b)=>a.root_sequence-b.root_sequence)) {
    const group=groups[event.event_type];if(!group) continue; // Valid retractions are terminal, not negatives.
    data[group].push({...event,tip_event_id:event.event_id});
    const name=event.payload.concept?.text.normalize('NFKC').toLowerCase();
    if(name && names.has(`${group}:${name}`)) data.warnings.push('POSSIBLE_DUPLICATE_SEPARATE_ENTITY_THREADS');
    if(name) names.add(`${group}:${name}`);
  }
  data.warnings=[...new Set([...data.warnings,'Records describe documented statements, not clinical absence, adherence or safety.'])];
  return {patient_id:source.patient_id,as_of_sequence:source.as_of_sequence,projected_at:new Date(time).toISOString(),
    event_count:source.as_of_sequence,projection_status:'COMPLETE',clinical_data:data};
}
export const supportedQuestions=Object.freeze([
  'Any blood thinners or anticoagulants before surgery?','Penicillin allergy history?',
  'Any documented latex allergy assessment?','Historical renal impairment?','Any recorded surgeries?',
  'Any recorded mental-health diagnoses?',
]);
const normalize=value=>value.normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase().replace(/\?$/u,'').trimEnd();
export function questionTopic(question) {
  const index=supportedQuestions.findIndex(value=>normalize(value)===normalize(question));
  if(index<0) throw new ApiError('UNSUPPORTED_QUESTION');return topics[index];
}
export function citation(event) {
  return {event_id:event.event_id,sequence:event.sequence,recorded_at:event.recorded_at,
    source_date:event.source.authored_on,occurred_on:event.occurred_on,occurrence_text:event.occurrence_text,
    source_kind:event.source.kind,source_author:event.source.original_author,review_status:event.review.status,synthetic:true};
}
export function answerQuestion(source,topic,time) {
  const data=project(source,time).clinical_data;
  const index=topics.indexOf(topic);
  const group=['medications','allergies','allergies','conditions','procedures','conditions'][index];
  const key=['ecosprin_demo','penicillin_demo','latex_demo','renal_impairment_demo','cholecystectomy_demo','mental_health_demo'][index];
  const records=data[group];
  const positive=records.filter(e=>e.payload.concept.term_key===key);
  const gaps=records.filter(e=>!termFamilies[e.event_type]?.includes(e.payload.concept.term_key));
  const negative=data.negative_findings.filter(e=>e.payload.scope.topic_key===topic);
  const lookup=gaps.length?'INCOMPLETE':positive.length && negative.length?'CONFLICT':'COMPLETE';
  const certainty=lookup!=='COMPLETE'?null:positive.length?'VERIFIED_POSITIVE':negative.length?'DOCUMENTED_NEGATIVE':'NOT_RECORDED_IN_VAULT';
  const selected=[...positive,...negative,...gaps].sort((a,b)=>a.sequence-b.sequence);
  const warnings=['This fictional vault and limited vocabulary do not establish clinical absence or safety.'];
  let answer;
  if(lookup==='INCOMPLETE') answer='Relevant records contain unmapped concepts. Available sources require clinician interpretation; no certainty verdict is given.';
  else if(lookup==='CONFLICT') answer='Positive records and separate negative declarations require clinician interpretation. Both sources remain visible; no certainty verdict is given.';
  else if(positive.length) answer='Matching documented history is present. Read each cited statement, status and source date; a prescription or stopped medicine does not prove current use or clearance.';
  else if(negative.length) answer='A dated source explicitly records a negative finding only within its stated assessment scope. This does not establish current clinical absence or safety.';
  else answer='No supporting record was found in this vault/topic at this sequence. Missing documentation does not establish absence or safety.';
  return {ruleset_version:'demo-topics-v1',topic_key:topic,lookup_status:lookup,certainty_state:certainty,answer_text:answer,
    source_citations:selected.map(citation),facts:selected.map(event=>({event_id:event.event_id,entity_id:event.entity_id,
      event_type:event.event_type,payload:event.payload,occurred_on:event.occurred_on,occurrence_text:event.occurrence_text})),
    ...(certainty==='DOCUMENTED_NEGATIVE'?{documented_negative_detail:negative.at(-1).payload}:{}),
    warnings,coverage:{vocabulary_version:'demo-topics-v1',unmapped_event_ids:gaps.map(e=>e.event_id),
      scope_description:`Fictional ${topic} records through patient sequence ${source.as_of_sequence}`}};
}

export function createVault(store,auth,operations,{now}) {
  function authorize(ref,patientId,encounterId,scope) {
    const ctx=auth.authenticate(ref);
    if(ctx.actor.role==='PATIENT') {auth.ownPatient(ref,patientId);return ctx;}
    if(!encounterId) throw new ApiError('RESOURCE_UNAVAILABLE');
    const assigned=auth.encounter(ref,encounterId);
    if(assigned.actor.role!=='CLINICIAN' || assigned.encounter.patient_id!==patientId) throw new ApiError('RESOURCE_UNAVAILABLE');
    return auth.encounter(ref,encounterId,{scope});
  }
  async function read(ref,{patientId,encounterId,kind,query={},intent,compute}) {
    auth.admitSensitive(ref);
    const scope=kind==='events'?'vault:read':kind==='query'?'vault:query':kind==='checks'?'affirmation:run':'triage:read';
    const authorizeRead=()=>{
      if(['query','checks'].includes(kind) && auth.authenticate(ref).actor.role!=='CLINICIAN') throw new ApiError('SCOPE_DENIED');
      return authorize(ref,patientId,encounterId,scope);
    };
    if(kind==='active-state') {
      try {store.runUnit(false,authorizeRead);} catch(error) {
        if(!['HISTORY_LOCKED','GRANT_ENDED','SCOPE_DENIED'].includes(error.code)) throw error;
        // Relationship was already checked; LOCKED is never an empty clinical record.
        return {locked:true,body:{authorization_state:'LOCKED',clinical_data:null}};
      }
    }
    const result=await operations.readProtected(ref,{intent,authorize:authorizeRead,maxBytes:1048576,
      capture:(ctx,receipt)=>{
        if(receipt && receipt.ruleset_version!==(kind==='checks'?'no-active-clinical-rules-v1':'demo-topics-v1')) throw new ApiError('INVALID_TRANSITION');
        const source=clinicalSource(store,patientId,receipt?.as_of_sequence ?? query.as_of_sequence);
        if((query.after_sequence ?? 0)>source.as_of_sequence) throw new ApiError('VALIDATION_ERROR');
        const outcome=receipt ?? {status:'CLINICAL_READ',changed:false,patient_id:patientId,...(encounterId?{encounter_id:encounterId}:{}),
          as_of_sequence:source.as_of_sequence,ruleset_version:kind==='checks'?'no-active-clinical-rules-v1':'demo-topics-v1',
          ...(intent?{query_id:randomUUID()}:{}),committed_at:new Date(now()).toISOString()};
        return {source:{...source,outcome,replayed:Boolean(receipt)},outcome};
      },
      compute:source=>{
        const shared={authorization_state:'AUTHORIZED',patient_id:patientId,encounter_id:encounterId ?? null,
          as_of_sequence:source.as_of_sequence,replayed:source.replayed};
        if(compute) return compute(source,shared);
        if(kind==='active-state') return {...shared,...project(source,now())};
        const page=source.rows.filter(row=>row.event.sequence>(query.after_sequence ?? 0)).slice(0,query.limit ?? 50);
        return {...shared,events:page,next_after_sequence:page.at(-1)?.event.sequence<source.as_of_sequence?page.at(-1).event.sequence:null};
      },
      recheck:(_ctx,snapshot)=>{
        const fresh=clinicalSource(store,patientId,snapshot.source.as_of_sequence);
        if(fresh.head_hash!==snapshot.source.head_hash) throw new ApiError('CLINICAL_INTEGRITY_INVALID');
      },
      audit:(ctx,snapshot)=>({patient_id:patientId,encounter_id:ctx.encounter?.encounter_id ?? null,operation:`CLINICAL_${kind.replaceAll('-','_').toUpperCase()}`,
        result:'RELEASED',details:{as_of_sequence:snapshot.source.as_of_sequence,
          ...(ctx.grant?{grant_id:ctx.grant.grant_id,mode:ctx.grant.mode}:{}),purpose:'OPD_CONSULTATION'}}),
    });
    return result;
  }
  return {read,query:async(ref,intent)=>{
    const {patient_id:patientId,encounter_id:encounterId,question_text:question}=intent.body;
    // Unsupported input is checked after current scope, before any source inspection.
    store.runUnit(false,()=>{
      const ctx=authorize(ref,patientId,encounterId,'vault:query');
      if(ctx.actor.role!=='CLINICIAN') throw new ApiError('SCOPE_DENIED');auth.csrf(ctx,intent.csrf);
    });
    const topic=questionTopic(question);
    return read(ref,{patientId,encounterId,kind:'query',intent,compute:(source,shared)=>({...shared,query_id:source.outcome.query_id,
      question_text:question,...answerQuestion(source,topic,now())})});
  },authorize};
}
