import { z } from 'zod';

export const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
export const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const topics = ['ANTITHROMBOTIC_MEDICATIONS', 'PENICILLIN_ALLERGY', 'LATEX_ALLERGY',
  'RENAL_IMPAIRMENT', 'SURGICAL_HISTORY', 'MENTAL_HEALTH_HISTORY'];
export const termKeys = ['ecosprin_demo', 'metformin_demo', 'telmisartan_demo', 'type2_diabetes_demo',
  'penicillin_demo', 'latex_demo', 'renal_impairment_demo', 'mental_health_demo', 'cholecystectomy_demo', 'dyspepsia_demo'];
export const scopes = ['triage:read', 'vault:query', 'affirmation:run', 'summary:export', 'vault:read'];

export function xmlText(value) {
  return [...value].every(char => {
    const cp = char.codePointAt(0);
    return cp === 9 || cp === 10 || cp === 13 || (cp >= 32 && cp <= 0x10ffff &&
      !(cp >= 0xd800 && cp <= 0xdfff) && cp !== 0xfffe && cp !== 0xffff);
  });
}
export const text = max => z.string().min(1).max(max).refine(xmlText);
const nullableText = max => text(max).nullable();
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => {
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
});
export const timestamp = z.iso.datetime({ offset: false }).refine(value => Number.isFinite(Date.parse(value)));
const concept = z.strictObject({ text: text(200), term_key: z.enum(termKeys).nullable(),
  coding: z.strictObject({ system: text(200), code: text(100), display: text(200) }).nullable() });
const medication = z.strictObject({ concept, statement_kind: z.enum(['PRESCRIBED', 'REPORTED_TAKING', 'ADMINISTERED']),
  status: z.enum(['ACTIVE', 'COMPLETED', 'DISCONTINUED', 'UNKNOWN']), dose_text: nullableText(200),
  route_text: nullableText(200), frequency_text: nullableText(200), duration_text: nullableText(200), reason: nullableText(500) });
const condition = z.strictObject({ concept, clinical_status: z.enum(['ACTIVE', 'RESOLVED', 'UNKNOWN']),
  verification_status: z.enum(['CONFIRMED', 'UNCONFIRMED']) });
const allergy = z.strictObject({ concept, clinical_status: z.enum(['ACTIVE', 'INACTIVE', 'RESOLVED', 'UNKNOWN']),
  verification_status: z.enum(['CONFIRMED', 'UNCONFIRMED']), reaction_text: nullableText(500),
  reaction_severity: z.enum(['MILD', 'MODERATE', 'SEVERE', 'UNKNOWN']) });
const procedure = z.strictObject({ concept, status: z.enum(['COMPLETED', 'REPORTED_COMPLETED', 'UNKNOWN']), note: nullableText(500) });
const negative = z.strictObject({ scope: z.strictObject({ topic_key: z.enum(topics), timeframe: z.literal('AT_ASSESSMENT') }),
  declared_by: text(128), declared_on: date, clinical_basis: text(500), scope_text: text(500) });
export const draftPayloadSchemas = { CONDITION_RECORDED:condition, MEDICATION_RECORDED:medication };
const base = {
  ledger_format: z.literal('v1'), event_id: id, patient_id: id, encounter_id: id.nullable(), sequence: integer.min(1),
  facility_id: id, entity_id: id, supersedes_event_id: id.nullable(),
  change_kind: z.enum(['INITIAL', 'CLINICAL_UPDATE', 'CORRECTION', 'RETRACTION']), change_reason: nullableText(500),
  occurred_on: date.nullable(), occurrence_text: nullableText(100),
  source: z.strictObject({ kind: z.enum(['CLINICIAN_ASSESSMENT', 'PATIENT_REPORT', 'DOCUMENT_REFERENCE']),
    reference: nullableText(128), authored_on: date.nullable(), original_author: nullableText(100), quote: nullableText(1000) }),
  capture: z.strictObject({ method: z.enum(['MANUAL', 'MOCK_ASR', 'FIXTURE_SEED']), fixture_id: id.nullable(),
    extractor_version: text(128).nullable(), confidence: z.number().min(0).max(1).nullable() }),
  recorded_by: id.nullable(), recorded_at: timestamp,
  review: z.strictObject({ status: z.enum(['CLINICIAN_REVIEWED', 'FIXTURE_NOT_CLINICALLY_VALIDATED']),
    reviewed_by: id.nullable(), reviewed_at: timestamp.nullable() }), synthetic: z.literal(true),
};
export const eventSchema = z.discriminatedUnion('event_type', [
  ['MEDICATION_RECORDED', medication], ['CONDITION_RECORDED', condition], ['ALLERGY_RECORDED', allergy],
  ['PROCEDURE_RECORDED', procedure], ['NEGATIVE_FINDING_RECORDED', negative],
  ['RECORD_RETRACTED', z.strictObject({ reason: text(500) })],
].map(([type, payload]) => z.strictObject({ ...base, event_type: z.literal(type), payload }))).superRefine((event, ctx) => {
  const fail = () => ctx.addIssue({ code: 'custom', message: 'Invalid clinical provenance or transition' });
  const initial = event.change_kind === 'INITIAL';
  if (initial !== (event.supersedes_event_id === null && event.change_reason === null) ||
      (!initial && (!event.supersedes_event_id || !event.change_reason))) fail();
  if ((event.event_type === 'RECORD_RETRACTED') !== (event.change_kind === 'RETRACTION')) fail();
  if (event.event_type === 'RECORD_RETRACTED' && event.payload.reason !== event.change_reason) fail();
  if (event.source.kind === 'DOCUMENT_REFERENCE' && !event.source.reference) fail();
  if (event.occurred_on && event.occurred_on > event.recorded_at.slice(0, 10)) fail();
  if (event.source.authored_on && event.source.authored_on > event.recorded_at.slice(0, 10)) fail();
  if (event.capture.method === 'FIXTURE_SEED') {
    if (event.encounter_id !== null || event.recorded_by !== null || !event.capture.fixture_id ||
      event.review.status !== 'FIXTURE_NOT_CLINICALLY_VALIDATED' ||
      event.review.reviewed_by !== null || event.review.reviewed_at !== null) fail();
  } else if (!event.encounter_id || !event.recorded_by || event.review.status !== 'CLINICIAN_REVIEWED' ||
    event.review.reviewed_by !== event.recorded_by || !event.review.reviewed_at ||
    Date.parse(event.review.reviewed_at) > Date.parse(event.recorded_at)) fail();
  if (event.capture.method === 'MANUAL' && (event.capture.fixture_id !== null || event.capture.extractor_version !== null ||
    event.capture.confidence !== null)) fail();
  if (event.capture.method === 'MOCK_ASR' && (!event.capture.fixture_id || !event.capture.extractor_version)) fail();
  if (event.event_type === 'NEGATIVE_FINDING_RECORDED' && event.payload.declared_on !== event.occurred_on) fail();
  if (event.event_type === 'MEDICATION_RECORDED') {
    const p = event.payload;
    if (p.status === 'DISCONTINUED' && !p.reason) fail();
    if (p.statement_kind === 'ADMINISTERED' && (p.status !== 'COMPLETED' || !event.occurred_on)) fail();
    if (p.statement_kind === 'PRESCRIBED' && p.status === 'ACTIVE' &&
        (!p.dose_text || !p.route_text || !p.frequency_text)) fail();
  }
});

// Safe metadata only. Domain routes can extend these explicit shapes when implemented.
export const receiptOutcomeSchema = z.strictObject({
  status: text(64), changed: z.boolean(), patient_id: id.optional(), visit_id: id.optional(), token_id: id.optional(),
  encounter_id: id.optional(), room_id: id.optional(), grant_id: id.optional(), request_id: id.optional(),
  draft_id: id.optional(), version: integer.optional(), event_ids: z.array(id).max(20).optional(),
  as_of_sequence: integer.optional(), committed_at: timestamp.optional(),
  session_id: id.optional(), expires_at: timestamp.optional(),
});

export const loginSchema = z.strictObject({ username:text(80), password:z.string().min(1).max(256) });
export const emptySchema = z.strictObject({});
export const actorSchema = z.strictObject({account_id:id,role:z.enum(['STAFF','CLINICIAN','PATIENT']),display_name:text(100),
  room_ids:z.array(id).max(10),permissions:z.array(text(64)).max(20),patient_id:id.optional()});
export const sessionResponseSchema = z.union([
  z.strictObject({authenticated:z.literal(false),actor:z.null()}),
  z.strictObject({authenticated:z.literal(true),actor:actorSchema,expires_at:timestamp,csrf_token:text(128)}),
]);

const errors = {
  AUTH_REQUIRED:[401,'Sign in to continue.','REAUTHENTICATE'], SESSION_ENDED:[401,'The session has ended.','REAUTHENTICATE'],
  INVALID_CREDENTIALS:[401,'Sign-in credentials were not accepted.','NONE'],
  LOGIN_REAUTH_REQUIRED:[409,'Start a fresh sign-in attempt.','REAUTHENTICATE'],
  ORIGIN_REJECTED:[403,'Request origin was not accepted.','NONE'], CSRF_REJECTED:[403,'Refresh session metadata before trying again.','NONE'],
  SCOPE_DENIED:[403,'This operation is not permitted.','NONE'], HISTORY_LOCKED:[403,'Record sharing is required.','NONE'],
  RESOURCE_UNAVAILABLE:[404,'Resource unavailable.','NONE'], GRANT_ENDED:[410,'The encounter allowance has ended.','NONE'],
  IDEMPOTENCY_CONFLICT:[409,'This key belongs to a different intent.','REFRESH_STATE'],
  STATE_VERSION_CONFLICT:[409,'State changed. Refresh before choosing the next action.','REFRESH_STATE'],
  INVALID_TRANSITION:[409,'This action is unavailable in the current state.','REFRESH_STATE'],
  VALIDATION_ERROR:[422,'Check the permitted request fields.','NONE'], MALFORMED_JSON:[400,'Malformed JSON request.','NONE'],
  PAYLOAD_TOO_LARGE:[413,'Request exceeds the size limit.','NONE'], UNSUPPORTED_MEDIA_TYPE:[415,'Use uncompressed UTF-8 JSON.','NONE'],
  RATE_LIMITED:[429,'Request limit reached. Try again later.','NONE'], AUTH_BUSY:[429,'Another sign-in check is running. Try again shortly.','NONE'],
  EDGE_BUSY:[503,'Storage is busy. Reconcile using the same intent.','SAME_KEY'],
  AUDIT_UNAVAILABLE:[503,'Required audit could not be saved.','NONE'], DEPENDENCY_UNAVAILABLE:[503,'A required dependency is unavailable.','NONE'],
  COMMIT_OUTCOME_UNKNOWN:[503,'The outcome is uncertain. Reconcile using the original intent.','SAME_KEY'],
  TIME_UNTRUSTED:[503,'Server time could not be trusted.','NONE'], SERVICE_NOT_READY:[503,'Service is not ready.','NONE'],
  INTERNAL_ERROR:[500,'An internal error occurred. Use the request reference.','NONE'],
};
export class ApiError extends Error {
  constructor(code,{commitState='NOT_APPLIED',retryAfter,fields,issuance}={}) {
    const selected=errors[code]?code:'INTERNAL_ERROR';const [status,detail,retry]=errors[selected];
    super(detail);Object.assign(this,{code:selected,status,detail,retry_strategy:retry,commit_state:commitState,retryAfter,fields,issuance});
  }
}
export const auditDetailsSchema = z.strictObject({
  reason_code: text(64).optional(), reason: text(1000).optional(), purpose: text(64).optional(),
  mode: z.enum(['PATIENT_APPROVED', 'BREAK_GLASS']).optional(), scopes: z.array(z.enum(scopes)).max(5).optional(),
  request_id: id.optional(), grant_id: id.optional(), session_id: id.optional(), draft_id: id.optional(),
  event_ids: z.array(id).max(20).optional(), source_dataset_id: id.optional(), dataset_id: id.optional(),
  seed_label: text(64).optional(), snapshot_at: timestamp.optional(), checkpoint_sha256: hash.optional(),
  ended_sessions: integer.optional(), cancelled_requests: integer.optional(), ended_grants: integer.optional(),
  version: integer.optional(), count: integer.optional(),
  previous_session_id: id.optional(),
});
