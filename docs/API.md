# Implemented API — through step 5

All paths below have the `/api/v1` prefix. These APIs use fictional local data. Capture, exact review/commit, cited history, reviewed summary/local FHIR and own-patient audit downloads are implemented. Optional checks disclose unsupported clinical-rule coverage. Pages are developed separately; an API route existing does not establish a connected browser flow.

## Transport and sessions

Use `credentials: include`. POST requires `Content-Type: application/json`, the exact configured frontend `Origin`, and a UUID `X-Idempotency-Key`. Authenticated POST also requires `X-CSRF-Token` from login/session recovery. Browser helpers keep CSRF/intents in page memory. JSON is bounded to 64 KiB, rejects duplicate/unknown fields and invalid UTF-8, and returns safe errors. Responses carry `request_id`, `server_time`, `X-Request-ID` and, except health, `X-Dataset-ID`.

| Method/path | Input / result |
| --- | --- |
| GET /health/live | Minimal LIVE response without database work. |
| GET /health/ready | Current clock/storage readiness; unavailable/draining returns 503. |
| POST /auth/login | `{username, password}` for a privately initialized fixed account. Safe actor, CSRF, absolute expiry; cookie secret only in Set-Cookie. |
| GET /auth/session | Current safe actor/CSRF/original expiry or anonymous state; no renewal. |
| POST /auth/logout | `{}`. Revoke this browser's session and its clinician access; patient logout preserves the sharing choice. |

The session maximum is 7,200 seconds. Matching-cookie login replay does not issue another cookie. Lost-cookie replay verifies credentials, ends the orphan and returns 409 LOGIN_REAUTH_REQUIRED; the next deliberate login needs a fresh key. Credentials never enter receipts.

## Queue commands

Versions are nonnegative integers. Every new room operation checks its current `expected_version`; transfer checks both rooms. A successful mutation increments each affected room once. Replaying an original key/body checks current actor permission first, returns the original outcome/versions with `replayed: true`, and does not repeat an announcement. New actions use a fresh key after refreshing state. Do not automatically retry a 409.

| POST path | Strict body |
| --- | --- |
| /queue/register | `room_id`, `intake_mode: MANUAL or SIMULATED_ABHA`, exactly one of `patient_id` or `patient: {display_name, language, date_of_birth?}`; `demo_identifier?` only in simulated mode. |
| /queue/rooms/{room_id}/call-next | `expected_version` |
| /queue/rooms/{room_id}/pause | `expected_version`, `estimated_return_at?` (future UTC timestamp) |
| /queue/rooms/{room_id}/resume | `expected_version` |
| /queue/tokens/{token_id}/repeat-call | `encounter_id`, `expected_version` |
| /queue/tokens/{token_id}/absent | `encounter_id`, `expected_version`, `absence_confirmed: true` |
| /queue/tokens/{token_id}/recall | `expected_version`, `return_confirmed: true` |
| /queue/tokens/{token_id}/transfer | `encounter_id`, `expected_version`, `target_room_id`, `expected_target_version`, `reason` |
| /queue/tokens/{token_id}/withdraw | `expected_version`, `reason`, `encounter_id` when current |
| /encounters/{encounter_id}/check-in | `expected_version`, `identity_check_confirmed: true` |
| /encounters/{encounter_id}/complete | `expected_version` |

Registration/recall require assigned staff; ordinary call/check-in/pause/resume allow assigned staff or clinician. Transfer/completion require the assigned clinician and checked-in encounter. Staff can withdraw a waiting/absent placement or a current token before check-in; a checked-in current encounter requires its clinician. Confirmation flags record fictional operator actions, not identity assurance.

Registration creates a local patient or links an existing one without account enrollment or demographic merging. A linked patient with an unresolved visit gets ACTIVE_VISIT_EXISTS; use its current token. Name is 1–100 characters, language en/hi, DOB valid/nonfuture and demo identifier at most 32 characters. Reasons are 1–500 nonblank characters. Simulated ABHA is explicitly unverified. At 100 unresolved visits per room (including current and absent), registration/incoming transfer returns QUEUE_CAPACITY_REACHED without issuing a token or closing the source.

Calls create fresh encounters; check-in and consent remain separate. Three recorded calls plus explicit absence confirmation park the current token and call the next waiting token atomically only when the room is ACTIVE. Checked-in patients cannot be marked absent. Recalls are FIFO ahead of ordinary entries. Transfers retain the visit/token and move at most two ordinary waiting positions forward behind recalls. Completion/withdrawal releases the slot with the next call explicit. Pause blocks calls, preserves order and never freezes consent time; resume does not call automatically.

Command responses include `status`/`outcome`, `changed`, `replayed`, `committed_at`, safe token/encounter references, `room_versions`, and position/message fields when applicable. Transfer returns both versions and `closed_encounter_id`; absence returns `called_token_id`/`called_encounter_id` or null. Empty ACTIVE call returns persisted NO_WAITING_TOKEN/changed false without changing the version/state-change timestamp.

## Queue reads and directions

| GET path | Result / access |
| --- | --- |
| /queue/rooms/{room_id} | Assigned staff/clinician: coherent current/waiting/absent snapshot, room version/service/estimate, minimal calling names, call attempts and check-in status. No DOB/history/consent choice. |
| /queue/display/{room_id} | Public labels, order/positions/service/fixed break message and recorded-call announcement. No patient/visit/encounter IDs, names, absent list or consent metadata. |
| /patients/me/visit | Own patient account only: latest visit/token, current room/destination/position and current encounter's allowance metadata; no other patient's data. |
| /navigation/route | Public configured sample route with `origin`, `destination`, optional `accessibility: STANDARD or STEP_FREE`, `language: en or hi`. |

Waiting positions are one-based; people ahead includes a current patient. Current has zero ahead; absent/terminal placements have null counts. These are positions, not wait-time estimates. `state_changed_at` differs from the shared response contact time. Announcement IDs identify actual recorded calls; polling/replay produces no new ID. Connected clients must establish a silent first/reconnect baseline, poll at two seconds with one request in flight, reject older room versions and show stale/fallback state on lost contact. Those page behaviors still need browser verification.

Directions return ROUTE_AVAILABLE or NO_CONFIGURED_ROUTE, map version, bilingual steps and FICTIONAL_SAMPLE_MAP_NOT_SURVEYED. Sample walkways are bidirectional. STEP_FREE excludes inaccessible edges; no path returns empty steps and staff assistance, without substituting stairs. Unknown nodes/extra or duplicate query fields return 422. No live indoor tracking, walking time or surveyed accessibility is claimed.

## Encounter allowance

| Method/path | Strict input |
| --- | --- |
| POST /encounters/{id}/allowance/request | `explanation`, optional unique `scopes`; replacement requires both `replace_consent_request_id` and `expected_request_version`. |
| POST /encounters/{id}/allowance/respond | `consent_request_id`, `expected_request_version`, `action: ALLOW, DENY or ASK_WHY`, `approval_channel: PHONE or ASSISTED_QR`, `note?`, `assistance?`. ASK_WHY requires a note. |
| POST /encounters/{id}/allowance/clarify | `consent_request_id`, `expected_request_version`, `explanation` |
| POST /encounters/{id}/allowance/revoke | `grant_id`, `expected_grant_version`, `approval_channel`, `reason?`, `assistance?` |
| GET /encounters/{id}/allowance/status | Participant metadata only; no clinical values. |
| POST /encounters/{id}/break-glass | `reason` (1–1,000 nonblank characters); no client-selected actor, registration, scopes or duration. |

Explanations, notes and revocation reasons are at most 500 nonblank characters. Request/clarify belong to the assigned clinician's exact session and an open checked-in encounter. Their replay fingerprints include that server-derived session; a second browser cannot reuse the first browser's request/emergency intent. Default scopes are triage:read, vault:query, affirmation:run, summary:export; optional vault:read needs explicit explanation/choice. A different active scope set needs revocation and a new request.

PHONE requires the matched patient account and no assistance object. ASSISTED_QR requires independent assigned staff with consent:assist and `assistance: {patient_present: true, identity_check_confirmed: true, patient_choice_confirmed: true}`. Server records the actual assistant/session, time and fictional visit-details check method. The requesting clinician cannot self-approve. Assistance records the patient's actual choice, including Deny/Ask Why/revoke; a QR/boolean is not authentication or proof of valid oral consent.

Requests last at most 300 seconds. Ask Why locks history; clarification retains the original deadline. Allow starts at most 900 seconds, capped by the requesting clinician session; denial/expiry/revocation does not alter queue priority or block completion. Equivalent pending/current access returns changed false without renewal. Decisions and versions are atomic. A replay retains the committed decision/expiry while returning the grant's current effective state/remaining time. Expired/closed context cannot issue a grant. Transfer/completion/absence/withdrawal ends every old encounter request/grant in that same transaction.

Status includes safe clinician/facility/purpose/explanation/scopes, request/version/deadline, grant/version/mode/remaining time and allowed actions. Patients/assistants can see all currently pending requests/live grants for that encounter and revoke individual grants. Clinicians see only their own session. `consent_request_id` is the domain identifier; `request_id` remains the HTTP trace. Grant IDs are references, never bearer credentials. Status has `clinical_data: null`; command responses attach that metadata-only status under `allowance`. Clinical data uses the separate protected endpoints below.

Break glass requires explicit emergency:read and the authenticated clinician's own seeded mock registration match, labelled SEEDED_MOCK_NOT_LIVE. It commits authorization/grant/audit before access, permits only triage:read and vault:query and never enables exports/writes. Denial is not an automatic emergency trigger; staff continue urgent care independently. Rejected authenticated attempts are audited; an uncertain committed response is not falsely audited as denied.

## Capture, saved drafts and exact review

These operations require the assigned clinician with `clinical:write` and an open, checked-in encounter. New care can be captured after history Deny/expiry without importing past history. Patients, staff/assistants and unrelated clinicians cannot read drafts. All clinical content stays in SQLite and authorized no-store responses.

| Method/path | Strict input / result |
| --- | --- |
| POST /scribe/transcribe | `encounter_id`, `input_mode: MOCK_FIXTURE`, `language: hi`, exact `fixture_id`; or `input_mode: MANUAL_TEXT`, `language: hi or en`, `text`. `expected_draft_version` is required to replace an existing draft and forbidden as a precondition against no draft. |
| GET /encounters/{id}/draft | Current draft or null, independently of history sharing. No query/body fields. |
| POST /scribe/drafts/{draft_id}/save | `expected_draft_version`, corrected `text`, `items` (0–20 strict incomplete typed items). Preserves original source/capture metadata, computes warnings, invalidates review. |
| POST /scribe/drafts/{draft_id}/review | `expected_draft_version`, `review_confirmed: true`. Validates exact stored complete items and source targets; binds actual reviewer/time and SHA-256 of canonical stored capture. |
| POST /scribe/commit | `draft_id`, `expected_draft_version`, `reviewed_payload_hash`. No clinical body or caller-selected event/author/time/hash. Appends exactly one reviewed batch atomically with terminal draft state, audit and receipt. |

Text accepts 1–8,000 nonblank Unicode characters, preserving exact wording; XML 1.0-disallowed controls/unpaired surrogates fail validation. Ordinary JSON remains bounded to 64 KiB; the complete canonical stored capture is capped at 128 KiB. No URL, binary audio, live ASR, microphone, provider override or automatic extraction from manual text exists. `USE_MOCK_ASR=false`, invalid configuration or a missing/corrupt registry disables only fixture capture with 503 ASR_MODE_UNAVAILABLE/retry NONE. Manual capture and queue operations continue.

The three immutable offline templates are `hindi_clip_1_dyspepsia` (one provisional condition, initially reviewable), `hindi_clip_2_bp_sugar` (unknown medicine/family-only history/unknown allergy, zero items), and `hindi_clip_3_scribe` (two incomplete update items needing actual targets/details/reason). Each says “Simulated transcription — predefined text; audio is not processed.” Confidence is null, never an accuracy or approval threshold. Manual entry initially has zero structured items and no simulation label. Ten capture requests can be admitted at once, including persistence; the eleventh gets 429 INGESTION_BUSY with Retry-After 1 and no queued work. Cancelling an active request does not release its permit before work ends.

Capture/save/review return `outcome: DRAFT_CAPTURED|DRAFT_SAVED|DRAFT_REVIEWED`, `draft_id`, `encounter_id`, `draft_version`, `draft_state`, `changed`, `replayed`, `committed_at`, `current_draft_version`, `snapshot_available`, and `draft` or null. The safe receipt fields also remain under `status`/`version`. The draft has `capture_schema_version: scribe-draft-v1`, input/language/fixture/extractor/simulation metadata, `original_text`, current `text`, `items`, server `warnings`, `edited`, `state`, `version`, review hash/account/time, committed IDs or null and computed `can_request_review`. That flag describes completeness, not review or clinical safety. An edit increments version and clears review. Review increments version without changing capture bytes; state/version/review metadata are excluded from the capture hash.

A matching-key replay returns original metadata. It attaches content only when the current draft still matches that original ID/version; otherwise `snapshot_available: false`, `draft: null` and the current version tell the client to fetch separately. A delayed first response follows the same rule. No extraction rerun or later-edit overwrite occurs. Commit returns safe IDs, `state: COMMITTED`, `draft_version`, consecutive `first_sequence`/`last_sequence`, `head_hash` and event IDs. Original safe commit receipts remain replayable after closure to the currently authenticated, still-permitted original actor; no new append or clinical body is returned. A new key cannot create another batch in that encounter. Closed uncommitted drafts remain retained, unsaved to the clinical record; post-close recovery is deferred.

### Typed draft items

Every item has exact keys `event_type`, `entity_id`, `change_kind`, `change_reason`, `supersedes_event_id`, `occurred_on`, `occurrence_text`, `source`, `payload`. Nulls are explicit. INITIAL starts with `entity_id: null`; the server allocates it before review. An existing initial ID may be retained only from this saved draft. INITIAL has null predecessor/reason; other change kinds require the current same-patient/entity/family tip and an actual reason. Source has exact keys `kind: CLINICIAN_ASSESSMENT|PATIENT_REPORT|DOCUMENT_REFERENCE`, nullable opaque `reference`, `authored_on`, `original_author`, `quote`; a nonnull quote must occur literally in the current text. Dates are full valid nonfuture dates or null; imprecise dates stay in occurrence_text. Source attribution does not become verified diagnosis through clinician review.

| Type | Exact payload keys / complete-item requirements |
| --- | --- |
| MEDICATION_RECORDED | `concept`, `statement_kind: PRESCRIBED|REPORTED_TAKING|ADMINISTERED`, `status: ACTIVE|COMPLETED|DISCONTINUED|UNKNOWN`, nullable `dose_text`, `route_text`, `frequency_text`, `duration_text`, `reason`. Active prescription requires dose/route/frequency; discontinuation requires reason; administration requires COMPLETED and known occurrence date. |
| CONDITION_RECORDED | `concept`, `clinical_status: ACTIVE|RESOLVED|UNKNOWN`, `verification_status: CONFIRMED|UNCONFIRMED`. Patient recollection remains UNCONFIRMED. |
| ALLERGY_RECORDED | `concept`, `clinical_status: ACTIVE|INACTIVE|RESOLVED|UNKNOWN`, `verification_status`, nullable `reaction_text`, `reaction_severity: MILD|MODERATE|SEVERE|UNKNOWN`. |
| PROCEDURE_RECORDED | `concept`, `status: COMPLETED|REPORTED_COMPLETED|UNKNOWN`, nullable `note`. A patient report cannot become a completed observed procedure. |
| NEGATIVE_FINDING_RECORDED | `scope: {topic_key, timeframe: AT_ASSESSMENT}`, `declared_by`, `declared_on`, `clinical_basis`, `scope_text`. Known declaration date must equal occurred_on. Clinician/patient declarations bind to the actual account/patient before review; documents require their explicit matching source author. |
| RECORD_RETRACTED | `reason`, equal to common change_reason; change kind RETRACTION. A terminal retraction removes usable evidence while preserving history and never creates a negative. |

Save permits explicit nulls for incomplete payload fields; review requires the complete event schema, 1–20 items, actual source support and valid targets. Unknown payload fields/families are rejected. `concept: {text, term_key, coding}` retains unmapped text with `term_key: null`; supplied local term keys must match the versioned exact alias list. No externally verified coding registry exists here, so live draft coding must remain null. Text bounds: concepts 200, dose/route/frequency/duration 200, reasons/reactions/notes/negative basis/scope 500, source quote 1,000, source author 100, reference/declarer 128, occurrence_text 100. No medication-name merging, invented standard codes or unsupported source inference occurs.

Prior-source updates/corrections/retractions additionally require current `triage:read` access to that exact patient's source. Unknown/unreadable/cross-patient or wrong-family targets fail safe 404; stale tips and duplicate same-thread items conflict. Source access is rechecked for save, review, commit and draft delivery. A read grant alone cannot write. No direct `/vault/events` or legacy `/scribe/dictate` write path exists.

## Cited history, questions and voluntary checks

All successful clinical reads verify the canonical patient chain, compute outside the transaction, then recheck current permissions/source and persist an access audit before the complete buffered response is released. The existing actor-sensitive-read limiter is 60/minute. Clinical answers/records stay out of receipts and ordinary logs. Revocation, logout, closure and tampering cannot use an old safe receipt to bypass these checks.

| Method/path | Access / input |
| --- | --- |
| GET /vault/patient/{patient_id}/active-state | Own patient, or assigned clinician with `encounter_id` query and `triage:read`. Related clinician without usable scope receives LOCKED/clinical_data null, never missing-record evidence. |
| GET /vault/patient/{patient_id}/events | Own patient, or clinician plus `encounter_id` and explicitly approved `vault:read`. Query `after_sequence` default 0, `limit` default 50/max 100, optional fixed `as_of_sequence`. |
| POST /vault/query | Assigned clinician with `vault:query`; strict `{patient_id, encounter_id, question_text}` (1–1,000 characters). |
| POST /vault/affirmation | Assigned clinician with `affirmation:run`; `{patient_id, encounter_id, intervention_type: MEDICATION|PROCEDURE|DIAGNOSTIC, planned_items: [1–20 strings, each 1–200], rationale?}` (≤500). |
| GET /audit/integrity-check/{patient_id} | Own patient only, no query fields. Actual verified PASS/FAIL, sequence/count, safe first-failure reference and tamper-evidence limitation. |

Event pages return complete event envelopes with previous/event hashes, fixed `as_of_sequence` and `next_after_sequence` or null. Reuse the captured as-of head for later pages; permission is checked on every page. Patient self-access continues after encounter closure and does not use a clinician grant. Active-state projects by entity/current tip in root order into medications, conditions, allergies, procedures and scoped negatives; retracted threads remain only in authorized history. It preserves actual source/occurrence/recording/review dates, report/order/status differences and possible-duplicate warnings. Empty lists never mean a negative assessment.

Only these six deterministic questions are accepted (Unicode NFKC, English case/whitespace normalization, optional final question mark):

1. Any blood thinners or anticoagulants before surgery?
2. Penicillin allergy history?
3. Any documented latex allergy assessment?
4. Historical renal impairment?
5. Any recorded surgeries?
6. Any recorded mental-health diagnoses?

Other, negated or compound questions return 422 UNSUPPORTED_QUESTION. Queries return `query_id`, original `question_text`, patient/encounter/as-of, `ruleset_version: demo-topics-v1`, topic, lookup status, certainty, cautious answer, actual `source_citations`, structured cited `facts`, coverage gaps and warnings. COMPLETE yields VERIFIED_POSITIVE, DOCUMENTED_NEGATIVE (with exact dated declaration detail), or NOT_RECORDED_IN_VAULT. Relevant unmapped concepts yield INCOMPLETE/null certainty; independently retained positive and negative declarations yield CONFLICT/null certainty. There is no newest-date winner. Fixture provenance stays FIXTURE_NOT_CLINICALLY_VALIDATED. Stopped prescriptions are historical evidence, not current ingestion or clearance. Replays reconstruct their original as-of/ruleset references under current permission; clinical text is not stored in receipts.

Optional checks currently return `evaluation_status: NOT_EVALUATED`, `ruleset_version: no-active-clinical-rules-v1`, empty findings, cited usable tips and explicit unsupported coverage. No authoritative, clinician-reviewed interaction rules are installed. `doctor_action_required: false` is fixed; no all-clear, safety score, mandatory acknowledgement or commit dependency exists. Telemetry/resource workload, connected pages and optional text AI remain later stages.

## Reviewed summary and local FHIR document

| GET path | Result |
| --- | --- |
| /encounters/{id}/summary | Readable JSON from exactly the encounter's committed reviewed batch. |
| /encounters/{id}/fhir-export | Raw application/fhir+json attachment, Composition-first local R4 4.0.1 mapping. |

No query fields, body, caller-selected patient/event list, profile or mode are accepted. Own-patient access is independent of a clinician grant and continues after closure. Assigned clinician access requires a checked-in open encounter and current patient-approved summary:export for that exact session/patient/facility/purpose. Staff/assistants, other patients/clinicians and emergency grants cannot export. Summary generation never renews consent or changes clinical state. GET requires no CSRF/key and writes no mutation receipt. Use deliberate user actions for read/print/download; automatic frontend actions are not implemented here.

Both routes verify the canonical patient chain, persisted capture hash, actual reviewer/time, complete ordered event IDs and exact reviewed-item/event content. They refuse any batch whose selected event is no longer its entity's current tip. Later unrelated appends do not invalidate the batch. Rendering is local and outside SQL; source/context/permission is rechecked before the durable release audit and final buffered delivery. A lost response/retry may create another generation/release audit, never another clinical event. An audit records permission to release, not proof of saving/printing.

Summary includes `summary_schema_version: reviewed-summary-v1`, `mapping_version: local-r4-v1`, generation UUID/time, dataset/patient/display name, encounter ID/status (OPEN or CLOSED), facility/room labels, captured as-of sequence, committed event IDs, draft ID/committed version, actual review account/display name/time/hash, capture mode/language/fixture/extractor/simulation metadata, `reviewed_text`, statements, sections and warnings. `synthetic: true`, `history_scope: COMMITTED_ENCOUNTER_BATCH`, and `fhir_validation: NOT_RUN` are fixed. Statements preserve complete event envelopes plus previous/event hashes, `render_kind: PRESCRIPTION|CONDITION|OTHER` and plain display text. Sections are CONTEXT, PRESCRIPTIONS, CONDITIONS, OTHER_STATEMENTS, NARRATIVE, PROVENANCE. Only current committed text is used; immutable original text, unrelated history, query answers and optional checks are not imported. Missing optional fields say “Not recorded”; empty sections do not mean clinical absence.

FHIR returns a Bundle of type document with identifier/timestamp/meta.lastUpdated, Composition first, Patient second, then prescribed MedicationRequests, Conditions, actual reviewing demo Practitioner and Encounter. Each resource has a fresh UUID id and matching urn:uuid fullUrl; all references resolve locally. Local underscore/long IDs remain Identifier values or escaped narrative. PRESCRIBED ACTIVE/COMPLETED/DISCONTINUED/UNKNOWN map to active/completed/stopped/unknown; text dose/route/frequency/duration are preserved without unit/timing conversion. Reported prescriptions have reportedBoolean true. No requester/original prescriber, onset, administration, appointment or clinical terminology is invented. Conditions retain provisional/confirmed status and recording time; unknown clinical status is omitted. Reports, administrations, allergies, procedures, dated negatives and retractions remain in narrative/provenance, with no machine-readable resource mapping for those families in this slice. No clinical codes, meta.profile, attestation, signature or ABDM conformance claim is added.

Strict application preflight checks this fixed mapping, supported fields/statuses, item coverage, UUIDs, references, context and escaped XHTML narratives. It is not an official validator. Narratives use fixed div/p/br templates; source characters are escaped, never executable HTML. The selected runtime makes no validator/terminology/provider network call. Headers include X-Export-ID and X-FHIR-Validation: NOT_RUN; FHIR has `Content-Disposition: attachment; filename="vaultmed-<generation UUID>.json"`. Downloads are raw Bundle JSON without an application wrapper; trace/dataset remain headers. Credentialed CORS exposes these headers and Content-Disposition. Separate generations can have different bytes/UUIDs; no offline validation report is inherited.

One summary/FHIR build can run at once across this process; another returns 429 EXPORT_BUSY, Retry-After 1, with no waiting queue. Each complete UTF-8 summary/document is capped at 1 MiB without truncation. Defined failures: 409 SUMMARY_NOT_COMMITTED (no final batch), SUMMARY_OUTDATED (later correction/retraction), OUTPUT_CONTEXT_CHANGED (changed captured context); 503 SUMMARY_SOURCE_INVALID or AUDIT_UNAVAILABLE; 413 EXPORT_TOO_LARGE; 500 FHIR_BUILD_FAILED for failed local application checks. No partial clinical body accompanies an error. Output failure never undoes a clinical commit.

Mapping references: [HL7 R4 documents](https://hl7.org/fhir/R4/documents.html), [MedicationRequest](https://hl7.org/fhir/R4/medicationrequest.html), [Condition](https://hl7.org/fhir/R4/condition.html), [narrative](https://hl7.org/fhir/R4/narrative.html). Official validation, browser printing and interchange remain unverified.

## Patient audit history, integrity and complete download

All three routes require current own-patient authentication with patient:self. Clinician grants, staff/assistance and QR references cannot provide access. The standalone integrity route is now patient-only, aligning the selected final API contract; the earlier step-4 clinician query form is not accepted.

| GET path | Input / result |
| --- | --- |
| /audit/patient/{patient_id} | Query after_audit_id default 0, through_audit_id optional captured bound, limit default 50/max 100. Returns complete matched rows for that page, fixed through bound and next_after_audit_id or null. |
| /audit/integrity-check/{patient_id} | No query. Actual ledger_format v1, status PASS or FAIL, checked_through_sequence, event_count, verified_at and head_hash. FAIL gives safe first_failure_sequence/reason_code and null head, not a reassuring verdict. Operational inability is a safe error. Compatibility integrity_status/checked_events remain on successful results. |
| /audit/export/{patient_id} | No query. Raw JSON attachment with `{content, sha256}` and a fresh X-Export-ID; no paging/truncation. |

History rechecks ownership on every page and audits access, without moving an explicitly captured through bound. It returns audit IDs, actual actor/patient/encounter/operation/result, UTC recorded_at milliseconds and strict details; these contain no passwords/cookie secrets/CSRF values. Integrity recomputes actual canonical/mirrored event bytes/links; a failed chain never becomes a fixed seal or proof of clinical truth.

Export authorizes first, then in one final write unit appends AUDIT_EXPORT and captures every matched-patient row through that export audit ID, including intervening rows and excluding other patients. Rendering/checksum occurs outside SQL, followed by current session/ownership recheck before delivery. There is no second recursive export audit. Content contains `audit_export_schema_version: patient-audit-v1`, patient/dataset, generation UUID/time, through_audit_id, complete_through_bound true, all bounded audit_events and actual chain_check (PASS or FAIL). The outer sha256 is SHA-256 of the exact UTF-8 canonical content object using sorted compact v1 JSON. Recompute with the same canonical encoding, not arbitrary property-order JSON.stringify. This checksum is not a signature, historical authenticity guarantee or independent anchor.

Complete audit output is capped at 1 MiB; oversized output returns 413 EXPORT_TOO_LARGE and never a partial dossier. An authorized export attempt can remain audited even if later rendering/size/delivery fails. Filenames use `vaultmed-audit-<generation UUID>.json`; no private filesystem paths or credentials enter output. Pagination remains available for authorized history when a complete dossier exceeds the cap. Restore/session invalidation and no-store rules apply to every page/download.

## Browser helper example

```js
import { api } from '/shared/api.js';
import { session } from '/shared/session.js';

await session.recover(); // Or signIn(username, passwordFromForm).
const room = await api.read('/queue/rooms/room_12');
const command = api.createIntent('/queue/rooms/room_12/call-next', {
  expected_version: room.version,
});
const outcome = await api.command(command);
const route = await api.read('/navigation/route', {
  origin: 'entrance', destination: 'room_12', accessibility: 'STEP_FREE', language: 'hi',
});
```

Keep the original intent for uncertain noncredential reconciliation. Automatic retries are at most two additional attempts, only transport loss/503 SAME_KEY, with full jitter and server Retry-After respected within five-second retry admission. 409/429 never silently repeat a new action. Session/dataset changes discard pending intents and late results. Pages must register clearing callbacks and render untrusted text safely. Actual browser cookie/CORS/proxy behavior and connected page flows remain separate verification.
