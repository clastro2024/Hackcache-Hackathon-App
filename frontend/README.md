# Frontend

Semantic HTML, one Tailwind CLI stylesheet and vanilla ES modules. Three core pages:
Patients, Clinical Encounter and Patient Visit. Login is a utility document.
Each page retains its own HTML, named CSS and named JavaScript file.

## Shared ownership

- `styles.css`: Tailwind input, approved brand tokens, local font faces, common
  controls, headers, notices, dialogs, responsive/reduced-motion/print defaults.
- `ui.js`: text-safe DOM helpers, consistent SVG icons, notices, announcements,
  field errors, busy controls, disclosures, native dialogs, local tabs and headers.
  These functions do not request data, authorize users or persist clinical content.
- `api.js`: existing credentialed requests, in-memory CSRF/intents, retry and
  dataset/context handling. Use its existing interface; do not duplicate it in pages.
- `session.js`: existing session recovery, sign-in/sign-out and absolute expiry.
  Page controllers must attach the required protected-content clearing callbacks.
- `config.js`: public API base only, emitted by the existing build.

Run the existing App commands from the repository root:

```powershell
npm run check:environment
npm run build
npm test
```

The build emits only the allowlisted public pages/shared modules/assets into dist.
It does not copy this document, raw Tailwind input, backend, tests or private data.
Do not edit generated assets/css/tailwind.css or introduce per-page Tailwind builds.
Local @font-face URLs resolve from the generated assets/css/tailwind.css location.

## Using the shared layer

Use `button` with optional `button--secondary` or `button--danger`; retain explicit
labels. For busy-label replacement, wrap the button's text in `data-button-label`.
`setBusy` preserves the original disabled state and does not determine save success.

Use visible labels, `field-control`, a stable error-element ID and `setFieldError`.
The helper preserves existing aria-describedby references. Client feedback never
replaces server validation.

`bindDisclosure` uses an existing button and a stable-ID panel. Account menus use
ordinary buttons/links and normal Tab order, Escape and outside dismissal.
`bindTabs` expects a local tablist, tabs with aria-controls and matching tabpanels;
tabs switch presentation only. Give every tab an ID and each panel aria-labelledby.

`bindDialog` uses native dialog/showModal for focus containment and background
inertness. Use a labelled title, visible `data-dialog-close` button and optional
`data-initial-focus` on the safe first control. Only one dialog opens at a time.
Dismissal never submits an action. Unsaved-work decisions belong to the page.

`createNotice` renders text, not HTML. Select semantic tone from the actual result.
Announce meaningful changes with `announce`; unchanged messages are not repeated.
No timer or animation can establish a successful mutation or failed save.

`mountHeader` renders the provisional identity and appropriate provider/patient
frame. Pass the authenticated account label/role and a real sign-out callback from
the page controller when integrated. Header labels do not establish a session.
Login, Patients, Clinical Encounter and Patient Visit use the session/API helpers.
Language/Help are local dialogs. English and Hindi interface labels are available
for the main workflows. Unmapped copy falls back to English; clinical notes,
reviewed summaries and source records retain their original wording. Translation
and comprehension still need representative user review. Only the interface-
language preference is stored in sessionStorage; clinical data is never stored there.

Patient surfaces use `patient-surface`: 18px scalable body, at least 48px action
targets and 56px prominent buttons. Keep consent choices equally prominent.
Use named semantic colors with text/icons; no color-only evidence or success state.

## Current boundary

Shared setup, login, the Patients ledger, Clinical Encounter and Patient Visit are implemented. The login utility
recovers the current session, validates credentials locally before submission,
clears the password after each attempt and routes by the server-returned role.
Uncertain sign-in requires password re-entry through the existing helper.

Patients reads only assigned rooms. Its continuous ledger shows actual current,
waiting and absent states; registration opens a local-visit sheet. Calling,
arrival check-in, three-call absence confirmation, staff-confirmed recall,
withdrawal with a reason, break/resume and clinician completion use the existing
versioned commands. Arrival does not approve history sharing. Completion does not
save a draft or call the next patient. Clinical navigation is limited to the
checked-in current encounter for a clinician with clinical:write. The encounter
page independently checks the assigned room/current patient/check-in before use.
Register patient remains visible for provider accounts: assigned intake staff can
use it; clinicians see a disabled control with a staff-only explanation.

Polling uses a two-second delay after completion with one read in flight. Room
versions and a page generation reject stale responses. Unchanged polls preserve
queue controls and focus. Contact loss, hidden-page transitions, session ending
and dataset changes clear private rows and form values. Reconnection checks the
session before displaying a fresh queue snapshot. Clinical data is never stored
in localStorage, sessionStorage or IndexedDB. An uncertain queue command retains
its original key/body in page memory and blocks new queue actions until checked;
keep the page open for reconciliation. Sign-out hides private content immediately
and reconciles its own original logout command independently.

Patient Visit consent and reviewed summary, assisted consent, token-slip and
authorized-summary printing, and existing-patient reference linking are connected.
Manual registration creates a local patient/visit without enrolling an account.
Authenticated name search remains unavailable. Transfer is explained as
unavailable: no destination-room catalogue/current target versions are supplied
by the current API. No endpoint, room label, queue success or patient fixture is
invented by the frontend. There is no additional dashboard or component framework.

## Clinical Encounter / F06

The approved two-pane composition is retained: patient context, Summary/Ask record
and sourced allergy/history on the left; visit note, assessment, new prescription
and Review visit on the right. More tools holds additional statements, optional
checks, source/current-draft recovery, reviewed summary and permissioned emergency
access. Age and demographics not supplied by the queue API are not invented.

- Session/room/current encounter and patient binding are checked through existing
  endpoints. The URL's identifiers are references, not authorization. Staff and
  unrelated clinicians cannot use the workspace. The server remains authoritative.
- Sharing requests and clarification show actual metadata and deadlines. The
  requesting clinician cannot approve a patient choice. Pending, Deny and ended
  history access leave eligible new-care notes usable. Emergency access is a
  separate deliberate audited command with a required reason and visibly simulated
  registration limits; it never substitutes automatically for a denial.
- A two-second nonoverlapping metadata poll and conservative monotonic deadline
  clear history/answers/sources at grant loss or expiry. Late responses require
  the current page/access generation and usable scope. Source-linked drafts are
  also cleared when their history access ends. Unsent data stays only in memory;
  hidden-page/contact/session/dataset transitions clear protected views and edits.
- Ask record offers the six deterministic questions documented in API.md. It does
  not call the optional AI routes or infer unsupported wording. Answers keep source
  dates, citation details, positive/dated-negative/missing states, coverage limits
  and fixture provenance. Unsupported input clears the earlier displayed answer.
- Manual entry creates zero automatic clinical items. The item editor supports
  all six typed families, incomplete values, source/dates/quotes and explicit
  new/update/correction/retraction actions. Changes to history select current
  projected tips under an active grant; no medicine-name merging or historical
  deletion is performed. The backend validates completeness and source binding.
- The API has one note-text field. This UI stores its two text fields as
  `Visit note:\n<text>\n\nAssessment:\n<text>` and splits that exact format on load.
  Other/fixture text is retained entirely in Visit note. The immutable original
  capture remains separate and viewable. No automatic clinical item is inferred
  from either text field; source quotes must match the stored text exactly.
- Save draft is explicit. Review visit first persists permitted edits, then shows
  the exact stored note/items/source/warnings. Confirm review calls the server's
  versioned review route; Save reviewed record uses its exact returned hash/version.
  Editing requires a fresh save/review. Successful draft persistence is distinct
  from clinical commit, summary generation and encounter completion.
- Independent write/history/access intents retain original key/body on uncertainty.
  An unknown question does not lock unrelated new-care editing. Newer edits cannot
  be replaced by an older save response. Draft conflicts require deliberate current
  draft loading; it explicitly warns before discarding unsent changes. Native
  before-unload protection covers unsent edits and uncertain intents.
- Simulated scribe uses only the named offline templates and says audio is not
  processed. Replacing a draft is explicit. Optional checks visibly return
  NOT_EVALUATED and never gate review/commit. Reviewed summary is a deliberate
  authorized read; print/FHIR download UI remains subsequent work.

## Verification recorded on 24 October 2026

- Node 24 environment check and the existing public build passed. JavaScript
  syntax checks passed for ui.js and all four page entrypoints.
- The App suite run during setup completed with 94 passed, zero failed and eight
  TODO markers. This is an observed run, not complete application acceptance.
- Eight bundled font files passed WOFF2 signature/declared-length checks and
  matched their dist copies. All twelve page files and shared ui.js matched dist.
- A temporary Chrome check passed the four document frames at 1440/390/320px,
  patient 18px body and 48px targets, enlarged/long-label reflow, Devanagari font
  loading, account keyboard dismissal, native dialog background inertness/focus
  return, text-safe notices, field descriptions, busy-state restoration, keyboard
  tabs, rendered semantic text contrast, reduced motion and print-base checks.
- The original foundation browser run remained PARTIAL: its final resource
  assertion failed, and the first diagnostic rerun was blocked by automatic
  approval review's spend cap. A later authorized diagnostic identified local
  Kaspersky script injection (gc.kis.v2.scr.kaspersky-labs.com). That host is absent
  from frontend source. Security software was not disabled; complete browser
  resource isolation remains unverified in this environment.
- The design detector had missing parser modules and fell back to regex checks;
  it did not establish computed contrast or accessibility conformance.

## Login and Patients verification

- Node 24.22.1 environment check, public build, changed JavaScript syntax and
  frontend whitespace checks passed. No dependency or backend implementation
  files were changed by this frontend section.
- The existing App suite passed: 144 total, 138 passed, six TODOs, zero failures.
  The first sandbox run could not connect to loopback or create a test junction
  (EACCES/EPERM); the authorized run outside that restriction passed. Existing
  TODOs are not completed by these results.
- Temporary hidden-Chrome checks used the existing HTTP test fixture with a
  disposable fictional database and generated private test passwords, never the
  operator's working database. Login/required fields, actual session/CSRF logout,
  assigned-room views, staff/clinician controls and 1440/390/320px reflow passed.
- With all initial registration responses withheld after actual server processing,
  every wire attempt kept the original key/body. Deliberate outcome checking
  recovered exactly one new visit. Chrome can itself repeat socket-reset requests;
  the harness checks their identical intent rather than assuming one wire request
  per fetch call.
- A held pre-command poll did not overwrite the later pause state. Unchanged
  polling retained focused controls. Contact loss cleared rows; recovery fetched
  session/current queue. Completion and resume did not auto-call. Three calls,
  explicit absence, arrival, staff recall, withdrawal reason validation and actual
  withdrawal passed. Injected session-expiry notification cleared rows, the open
  sheet and unsubmitted values. No uncaught application exception was observed.
- The complete browser run remains PARTIAL solely at its final no-external-HTTP
  resource assertion, where the local Kaspersky injection was observed. Earlier
  harness count/focus/navigation assumptions were corrected; failed runs are not
  represented as complete passes. Hosted cookies/CORS/TLS, full accessibility,
  patient consent-page integration and representative comprehension remain
  unverified. Screenshots were visually inspected for the login/ledger/sheet.

## F06 verification

- The Node 24 environment check, public build, encounter JavaScript syntax and
  frontend whitespace checks passed. This section changed only the encounter
  HTML/CSS/JavaScript and this frontend document. It added no dependency, backend
  route, schema, provider or permanent test fixture.
- The existing App suite at verification time recorded 158 tests: 153 passed,
  five TODOs and zero failures. Concurrent backend work is outside these frontend
  edits; the observed run is not complete application acceptance.
- Ten temporary Chrome workflow scenarios used actual existing HTTP endpoints,
  cookies/CSRF and disposable fictional SQLite data. They passed current-encounter
  binding; Deny with continued manual notes; zero automatic manual items; explicit
  prescription/source entry; preservation of edits made during an earlier save;
  actual Allow and sourced positive/missing/dated-negative answers; unsupported
  question recovery; NOT_EVALUATED checks without a save gate; and offline-template
  simulation labels. Desktop 1440px and mobile 390/320px reflow passed after fixing
  the question form's intrinsic grid width. Screenshots of the two panes and review
  dialog were inspected.
- Exact server review preceded clinical commit. With every initial commit reply
  withheld after server processing, original-key checking recovered the outcome
  and the disposable database contained exactly one new encounter clinical event.
- Actual patient revocation cleared history, answer and source views. A response
  released before revocation but held by the local test proxy could not repaint
  those views when later delivered. Injected session-expiry notification cleared
  the complete workspace and dialogs.
- Overall browser verification is PARTIAL: the final resource-isolation assertion
  failed on the previously identified local Kaspersky injection host. The report
  explicitly records this limitation. Earlier fixture/readiness assumptions and
  the actual narrow-grid defect were corrected; failed runs are not counted as
  complete passes. No machine security setting was changed.

Patient Visit, assisted consent, transfer catalogue integration, printing/FHIR
download controls, existing-patient linking, complete translations and representative
comprehension remain pending. All six item-editor families and prior-source changes
need broader browser coverage; the current walkthrough exercises a manual
prescription and scripted condition. Full accessibility, hosted cookies/CORS/TLS
and production identity/clinical validation are not established by these checks.

## Patients visual-fidelity correction

The approved staff/awaiting-arrival reference and the clinician/checked-in view
are distinct operational states. The original implementation also had actual
visual drift: undersized row text, a Current label with the same fill as its row,
loose action placement, compressed rows and different toolbar spacing.

- patients.css now scopes the reference header/toolbar geometry to this page,
  restores the 40px title, 28px semibold current name, 30px current token, 24px
  ordinary names/tokens, distinct Current chip, 124px current row, fixed column
  proportions, quieter contextual menus and right-aligned primary actions.
  Responsive rules retain single-line desktop tokens/actions and mobile reflow.
- patients.js adds clock/phone status/action icons and the absent disclosure
  chevron, keeps real queue state/counts, and places current-patient contextual
  operations behind the Current chip. Waiting rows retain accessible overflow
  controls. Current disclosure supports keyboard open, Escape and focus return.
  Update text uses actual successful contact time in the reference date style.
- Register patient is visible but disabled for clinicians; its title/accessibility
  description explains the staff requirement. Both opening and submitting still
  check intake permission. No backend authorization or operational state changed.
- index.html scopes the page styles and supplies the permission description;
  shared ui.js adds only three static SVG paths. No dependency or backend source
  was edited by this correction.

Verification: environment/build/syntax/whitespace checks passed. The App suite at
verification time recorded 166 total, 161 passed, five TODOs and zero failures.
Temporary Chrome checks passed at 1486/1388/390/320px using an isolated fictional
database. They checked current typography/chip contrast, single-row desktop
toolbar and 124px current row, both actor roles, keyboard disclosure, real staff
registration, repeat-call and arrival confirmation. Screenshot checks cover the
staff awaiting-arrival reference state and clinician checked-in state. Earlier
token/action wrapping defects and harness assertions were corrected; failed runs
are not complete passes. Resource isolation retains the local Kaspersky-injection
limitation described above. The existing preview server was confirmed READY and
serving the corrected page/CSS; no restart or working-data change was required.

## Patients typography and header follow-up

Reduced the Patients page type scale slightly while retaining the current-patient
hierarchy and existing control heights: title 40 → 36px, current name 28 → 26px,
current token 30 → 28px, ordinary names/tokens 24 → 22px, and smaller supporting
labels. Responsive sizes were reduced consistently. patients.css removes the
Actions heading's fixed left inset and aligns its text with the right edge used
by both single-button clinician and two-button staff action groups.

shared/styles.css sizes the account person icon to span the compact two-line
account copy, removes extra line spacing and centers the chevron on that block.
The icon remains visible at mobile widths. No JavaScript, backend, dependencies,
permissions or working patient data changed in this follow-up.

Verification: environment/build and whitespace checks passed. Temporary Chrome
checks passed five grouped layout/workflow checks with a disposable fictional
database, including heading/button alignment, account icon/labels/chevron geometry,
current text sizes, desktop/mobile widths 1486/1388/390/320px, account sign-out,
registration, repeat calling and arrival confirmation. No uncaught browser
exceptions occurred. Host-injected Kaspersky requests remain the previously noted
resource-isolation limitation. The existing private preview database was reopened
without initialization/reset; /api/v1/health/ready reported READY and /patients/
returned HTTP 200. Remaining frontend implementation scope is unchanged.

The required App suite passed with loopback access: 166 total, 161 passed, five TODOs and zero failures. An earlier sandbox-restricted run could not exercise local HTTP boundaries; it is not counted as a pass.

## Patients compact text and custom controls — 25 October 2026

- patients.css now sets --ui-text-scale to .85. Its explicit font sizes and shared
  typography multiply by this value, reducing Patients text to 85% of the previous
  sizes without shrinking layout spacing or button hit areas. Other pages retain
  their current type scale. The Current badge is now white on solid brand petrol.
- patients.js separates the noninteractive Current badge from an explicitly
  labelled More actions disclosure in the Actions column. Eligible waiting rows
  also show More actions. Existing permission checks and queue handlers remain;
  menu commands use compact menu rows. Escape/outside dismissal remains supported.
  Mobile menus align to the cell's start so the opened panel fits the viewport.
- shared/styles.css supplies branded select triggers and, where base-select is
  supported, rounded custom option pickers with selected marks and focus states.
  Native controls retain values, validation, keyboard behavior and disabled states;
  unsupported browsers retain a styled trigger with their native picker. Shared
  checkbox/radio styles include checked, indeterminate, disabled, focus and forced
  color fallbacks. No checkbox was added to a product flow; a temporary browser-only
  input verified Space-key toggling. Account-menu styling remains shared.
- encounter.css gives the More tools trigger a matching custom chevron and open/
  hover treatment. No clinical behavior, endpoint or backend source changed.

Verification: environment/build/syntax/whitespace checks passed. App tests: 166
 total, 161 passed, five TODOs, zero failures. Temporary isolated Chrome checks
passed six grouped layout/workflow checks: exact reduced typography, solid Current
badge colors, distinct visible More actions, keyboard open/Escape, desktop/mobile
reflow at 1486/1388/390/320px, opened mobile menu bounds, native custom picker in a
registration dialog, keyboard selection/form value, checkbox toggle, real staff
registration, repeat call and arrival. Desktop, mobile and opened-picker screenshots
were inspected. The previously documented Kaspersky host-injection limitation
remains; these checks do not establish complete resource isolation or accessibility
conformance. No dependency, backend, private setting or working patient-data edit
was part of this section. Remaining page implementation scope is unchanged.

## Patient Visit — connected page, 25 October 2026

Replaced the Patient Visit shell with the finalized pending-request and active-
sharing/summary layouts. Patient-facing type remains readable at the approved
patient scale. No destination, room, directions, queue position, waitlist or call
widgets are rendered from the larger visit API response.

Files and behavior:

- patient-visit/index.html supplies visible Language/Help through the shared header,
  a private visit region, sharing requests/grants, deliberate reviewed-summary
  controls and a supporting record/access-history disclosure.
- patient-visit.css implements the open request document, equal Allow/Deny buttons,
  compact sage sharing status, rounded reviewed-summary panel, responsive layout
  and dedicated print surface. It does not change the Patients text scale.
- patient-visit.js recovers the actual patient session and own visit; checks returned
  patient/encounter bindings; uses nonoverlapping two-second metadata polling; and
  preserves focus and unsent questions on unchanged snapshots. Requests and grants
  render independently. Displayed scopes come from each actual request/grant,
  including detailed history only when supplied. Ask Why requires a bounded note;
  clarification retains the original deadline. Maximum grant copy respects the
  clinician-session cap. Effective request/grant states remain server authority;
  conservative monotonic deadlines remove expired local actions without renewal.
- Decisions use PHONE, exact request/grant versions and the shared in-memory
  idempotent intent. Unknown choices retain the same key/body and block conflicting
  choices until checked. Metadata reads begun before a choice cannot overwrite
  its result. Context changes, hidden state, lost contact, session expiry and dataset
  invalidation clear private content and reject delayed responses. No patient or
  clinical browser storage is added.
- Summary viewing and printing are explicit protected reads of the latest encounter's
  committed reviewed batch. No next-step advice is inferred. Exact reviewed text,
  actual reviewer/time, statements and source/limits are available. Refresh checks
  for later changes; print fetches fresh output before preparing printable content.
  Stop sharing and encounter closure do not remove own-summary access.
- Supporting controls page through a fixed audit snapshot, run the actual integrity
  endpoint and request patient-owned audit/local-FHIR JSON downloads. Integrity
  PASS is described as record-link verification, not clinical truth or a signature;
  FHIR remains limited local mapping with official validation NOT_RUN.
- shared/ui.js adds the print SVG and patient-account copy distinguishing Sign out
  from Stop sharing. Existing provider behavior is preserved. No backend, dependency,
  private configuration or working clinical database content was edited.

Validation: environment/build/syntax/whitespace checks passed. The App suite at
verification time recorded 169 total, 164 passed, five TODOs and zero failures.
A temporary real-HTTP/Chrome harness with disposable fictional storage passed six
scenario groups: patient ownership, equal choices and visible utilities; Ask Why/
clarification/Deny and unsent-question preservation; exact limited scopes and lost-
response Allow reconciliation with one grant; deliberate reviewed summary and own
access after revocation/closure; audit/integrity/output/print content; visibility-
handler and connection clearing with a held late summary; and exact server 300-
second request, 900-second grant and session expiry boundaries. Responsive checks
covered 1440/853/390/320px. Screenshots of request, sharing/summary, mobile and print
CSS were inspected. Print content was captured with window.print intercepted;
physical/OS print-dialog behavior is not established. Visibility-handler testing
used a controlled document.hidden event. An initial expiry harness used the wrong
clock option and then a clock preceding initialization; those runs failed and are
not passes. Corrected final runs passed. Kaspersky host-injected requests retain
previous resource-isolation limitations; no accessibility-conformance claim.

At that milestone, remaining frontend scope included staff assistance, reference
linking, token printing and Hindi interface labels; the completion section below
supersedes that list. Representative comprehension/accessibility checks and hosted
verification remain pending. A prior-visit summary catalogue is not exposed by the current
own-visit API; this page uses the latest encounter and does not invent a catalogue.
No additional core page or backend endpoint was created.

A separate browser download check saved and parsed both JSON files in an isolated temporary profile: the own complete audit dossier with its checksum and the Composition-first local FHIR document Bundle. The temporary files were removed during cleanup. Unchanged recovery notices also retain their existing button to preserve keyboard focus across metadata polls.

## Frontend completion and patient layout — 25 October 2026

- patient-visit/index.html, patient-visit.css and patient-visit.js retain the approved
  request and sharing/summary compositions with a .85 text scale, aligned header
  and content widths, tighter section spacing, equal Allow/Deny controls, a sage
  sharing panel and a bordered reviewed-summary card. Empty states explain the
  actual absence of sharing or committed output. Successful choice notices clear
  after an authoritative metadata refresh. Print is the main loaded-summary action;
  Refresh remains available. Dates, names, scopes and expiry come from actual data.
- patients/index.html, patients.js and patients.css add existing-reference intake,
  token printing and staff-assisted choices. Existing intake submits patient_id
  without demographic merging or a fabricated name-search result. The printed slip
  contains the token/room and actual sample step-free guidance, with staff fallback
  and a not-surveyed label; it contains no clinical history. Assistance is available
  only to permitted staff for the checked-in current patient. It displays actual
  requests/scopes/deadlines, requires confirmation of the patient's presence,
  checked visit details and actual choice, and submits versioned ASSISTED_QR
  Allow/Deny/Ask Why/revoke commands. The printed reference supplies no authority.
  Uncertain results use the existing immutable same-key reconciliation flow.
- shared/ui.js implements the English/Hindi interface preference, including mapped
  accessibility labels, placeholders and titles, with dynamic content support and
  an English round trip. Protected source/record regions and input values are
  excluded. The preference does not select an actor, grant access or translate
  clinical evidence. Native branded selects, checkboxes and dialogs remain in use.
- encounter/encounter.js and encounter.css add current-grant reviewed printing and
  a real Composition-first JSON download. Each read rechecks the existing server
  endpoint and rejects stale page/access responses. Optional question interpretation
  is unchecked initially. The notes-only brief requires an explicit action, displays
  generation/source quotes as a proposal, and offers a deliberate Apply action that
  changes only the unsaved visit note. Save, exact review and commit remain separate;
  generated clinical items are never added automatically. No browser provider key,
  SDK, automatic provider request or new backend endpoint was added.
  Empty proposals offer no Apply action. A saved proposal is reused only at the
  version immediately following its source; later saved edits require a fresh
  explicit request rather than silently reusing older generated text.

The existing preview patient-a had no active grant, pending request or committed
summary when diagnosed. That state is truthful. To see the populated design, an
authenticated clinician requests sharing, the patient or permitted independent
staff records the patient's choice, and the clinician reviews and commits the
visit. The patient then explicitly checks the reviewed summary. No working preview
consent or clinical record was fabricated to populate screenshots. The old mockup's
two-minute copy remains superseded by the actual session-capped 900-second policy.

Validation: Node 24.22.1 / SQLite 3.53.4 environment checks and the public build
passed. npm test recorded 169 total, 164 passed, five TODOs and zero failures,
skips or cancellations (46,181.4284 ms). Temporary real-HTTP/Chrome checks passed
four additional grouped workflows: staff Ask Why/clarification/Allow/revoke with
required assistance and lost-response reconciliation to one grant; existing-reference
intake and history-free sample token printing; English/Hindi visible/accessibility
label round trips with original clinical text preserved and disabled AI fallback;
and refreshed clinician print plus a natively saved/parsed FHIR JSON document.
The six Patient Visit scenario groups also passed against the compact layout,
including own-summary access after revocation/closure, delayed response clearing,
300/900-second server boundaries and session expiry. Screenshots were inspected at
desktop and mobile sizes; layout checks covered 1440/853/390/320px. Chrome's actual
font report confirmed custom IBM Plex Sans regular and semibold faces. Printing
was intercepted for content/CSS checks; physical/OS print behavior was not verified.

A separate successful-proposal browser check passed seven assertions using three
local stub responses and zero live provider calls: no automatic request; notes-only
context and visible source quote; unchanged original note before Apply; reopening
the same saved proposal without regeneration; later saved edits requiring a fresh
proposal; empty output preserving the note with no Apply; and deliberate Apply,
Save, Review and Commit preserving the one clinician-supplied test item without
generated additions. The server's existing structured-item review requirement was
preserved. Initial temporary harness failures from draft-envelope/version handling,
case-sensitive labels and an item-free review assumption were corrected; those
failed attempts are not reported as passes.

These browser checks use disposable fictional databases/profiles. Kaspersky injected
its resource host into the local browser, so they do not establish complete resource
isolation. They also do not establish accessibility conformance, translation quality,
actual oral-choice verification, hosting behavior or general AI quality. No live
provider request was used for frontend verification. Official FHIR validation
remains NOT_RUN. Existing backend acceptance TODOs remain unchanged.

Remaining dependencies: authenticated patient discovery, an authoritative transfer
destination/version catalogue and a prior-visit catalogue are absent from the current
API. The frontend does not invent those results. Hosted cookie/TLS behavior and
representative accessibility/comprehension review require separate verification.
Backend code, dependencies, private AI configuration and working clinical contents
were preserved throughout this frontend work.

## Testing clinician and patient together — 25 October 2026

Keep the requesting clinician signed in. Open the patient account on another
device, another browser/profile, or a private window separate from the clinician's
normal window. Two normal tabs share the session cookie. Signing out or replacing
the requesting clinician's session cancels its pending requests and ends its grants;
pending requests also expire after at most five minutes. This behavior is intentional
and is not bypassed for demo account switching. Permitted independent staff can
record the patient's actual choice through the assisted workflow instead.

Read-only diagnosis of the two reported preview requests found both successfully
created and then CANCELLED with end_reason LOGOUT, approximately 75 and 10 seconds
after creation. No consent or clinical data was changed during diagnosis. F06 now
explains this lifetime in its pending-request notice. The clinician account menu
also explains the effect before Sign out; both notices have Hindi labels. No new
confirmation step or backend change was added.

## Staff queue refinement — 25 October 2026

This section supersedes the earlier Current-chip presentation. patients.js now
renders a bold petrol 0 with an accessible current-patient label; it does not
change the server's waiting positions. The pause helper has a dedicated service-delay
class. shared/ui.js includes the Hindi equivalent of the current-position label.

patients.css gives the wide toolbar five defined columns, a wider room selector
with centered contents/visible picker arrow, a larger Patients heading and tighter
spacing. The paused explanation sits below On break. Smaller screens use deliberate
rows; narrow action groups wrap as whole buttons rather than splitting their labels.
Queue values are slightly smaller while the current patient's name/token retain
their hierarchy. The current status's main line centers with the other values and
its explanation sits underneath. Removing the extra border spacer after the current
row gives the first waiting row the same alignment as subsequent waiting rows.

The table and expanded absent list share column widths. Absent tokens and patient
names align with their corresponding table columns, use smaller type, and their
Confirm return/More actions controls form a compact, vertically centered group at
the right. Mobile absent rows reflow explicitly. Native selector behavior, More
actions, confirmation dialogs and existing permission/command handlers are retained.

Validation: environment/native checks, public build, JavaScript syntax and whitespace
checks passed. npm test: 169 total, 164 passed, five TODOs, zero failures/skips/
cancellations (43,101.6626 ms). A disposable real-HTTP/Chrome check passed three
grouped scenarios across 1486/1388/1280/1100/1024/853/768/390/320px: no horizontal
overflow; one centered paused toolbar row at the three wide sizes; selector width
and picker open/Escape; primary/status/subtext and waiting-row alignment; matched
absent columns/action centers and reduced type; plus actual pause/resume, confirmed
return, repeat call and arrival. Desktop/mobile screenshots were inspected in two
bounded rounds. The running preview returned HTTP 200 for readiness and the updated
queue CSS/JS. No working patient data or backend source was modified.

The browser's previously documented Kaspersky resource injection remains; these
checks do not claim complete resource isolation, hosted qualification or accessibility
conformance. Existing acceptance TODOs and API-dependent remaining scope are unchanged.

## Compact selector and absent menu — 25 October 2026

Supersedes the preceding wide-selector/petrol-position presentation. patients.css
now fixes the room field at 9.5rem (152px, under half the previous 352px desktop
width), retaining its native picker and responsive bounds. Current position 0 uses
the same font size, weight and dark ink as the current token, including mobile.
patients.js renders In consultation without the tick or staff-only explanatory
sentence. The awaiting-arrival clock, call count and existing commands remain.

Only absent-row menus now open above their trigger, with an upward closed chevron.
Main queue menus retain their existing placement, and native disclosure/focus,
Escape and outside dismissal behavior is preserved. No backend, dependency or
working patient-data change was made.

Environment/build/syntax/whitespace checks passed. The disposable real-HTTP/Chrome
check passed three grouped layout/workflow scenarios at the same nine widths,
verifying the 152px selector, matching token/0 typography, ink color, plain checked-in
status, upward menus within desktop/mobile viewport bounds, Escape dismissal and
actual pause/resume, return, repeat call and arrival. Desktop and mobile screenshots
were inspected. The live preview served the updated CSS with HTTP 200. The previously
documented browser injection and accessibility/hosting verification limits remain.

Full regression result at this verification: 170 total, 165 passed, five TODOs,
zero failures/skips/cancellations (42,584.9577 ms). Concurrent unrelated changes
were preserved; this section changed only queue presentation and its documentation.

## Room-selector sizing follow-up — 25 October 2026

patients.css adjusts the room selector to 13rem (208px) and restores current position
0 to brand petrol while retaining its larger size. A scoped decorative chevron is
drawn independently of the browser picker icon, with reserved label space, disabled/
open states and pointer-events:none. The underlying native select retains all form,
keyboard and picker behavior; other selectors are unchanged.

Environment/build/whitespace checks and three existing disposable browser workflow
groups passed across nine viewport widths. The check verified the 208px width,
petrol 0, visible arrow, a physical click on the arrow area opening the native
picker, Escape dismissal and the retained queue actions. Desktop/mobile screenshots
were inspected. No backend, dependencies, clinical contents or browser storage changed.

The preview returned HTTP 200 with the new selector, chevron and color rules.
Full npm test: 170 total, 165 passed, five TODOs, zero failures/skips/cancellations
(44,320.4244 ms). Existing browser-environment and hosted-verification limits remain.
