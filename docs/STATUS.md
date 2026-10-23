# Product scope and implementation status

Updated 23 October 2026. This is a concise app-facing scope summary; approved intent and implemented controls remain distinct.

## Main product

VaultMed / CharakVault connects provider-led consultation with hospital OPD operations. Clinicians use relevant record context and reviewed documentation; staff manage intake and flow; patients make understandable record-sharing decisions with minimal clerical work. Clinics/hospitals are intended buyers; the core patient vault is intended to remain free.

## Main features to deliver

1. **Assisted registration and tokens:** minimal visit details, optional simulated ABHA intake and one confirmed token.
2. **Patients/worklist and queue operations:** assigned room/service context, calls, arrival/check-in, absence after three recorded calls, recall, transfer, break/resume and completion.
3. **Hospital guidance:** staff/printed landmark directions and public-safe token/room projection; accessible routes only where the sample map supports them.
4. **Patient-controlled sharing:** meaningful Allow / Deny / Ask Why and Stop Sharing; authenticated patient or independently permitted assistance; up to 900 seconds of scoped encounter access.
5. **Clinical history:** source/date/status-linked records with append-only corrections that retain earlier history.
6. **History questions:** supported questions with positive, explicitly documented negative and not-recorded distinctions. Incomplete/conflicting evidence does not acquire a certainty verdict.
7. **Optional clinical checks:** supported advisory cross-checks without mandatory acknowledgement or automated prescribing changes; unsupported rules remain explicit.
8. **Capture and review:** manual entry and visibly simulated offline scribe examples, editable draft, review of exact items, then final clinical save.
9. **Reviewed output:** authorized prescription/instructions and local Composition-first FHIR R4 document export; no live ABDM integration or conformance claim.
10. **Access accountability:** permitted access history and patient audit download; separately authenticated, reasoned and audited limited emergency access.
11. **Accessible local operation:** readable Hindi/English design, keyboard/non-color/reduced-motion support, staff/paper alternatives and truthful recovery when the local server cannot be reached.

These are targets. The README's current-snapshot table describes the existing implementation.

## Three core pages

- **Patients (Doctor/Staff):** role-permitted worklist and queue actions, with registration in a sheet.
- **Clinical Encounter:** authorized history, questions, optional checks, notes, review and saving.
- **Patient Visit:** minimal visit reference, record-sharing request/status/control and reviewed summary; visible Language and Help.

The current Patient Visit scope excludes directions, destination, queue information and waitlists. Staff, paper and public-safe guidance support hospital operations outside that page. Sign-in and recovery are utilities; record/source/access-history details are supporting disclosures. Sharing a visual frame never grants another role's permissions.

## Architecture target and current gaps

The target stack is one FastAPI process, SQLite through SQLAlchemy and vanilla HTML/CSS/JS. Persist authoritative operations before acknowledgement, enforce role/session/CSRF and server-resolved access grants, reconcile idempotent mutations and preserve clinical source/review provenance.

The initial app snapshot instead has in-memory singleton services and no durable recovery, queue/navigation implementation, authenticated actor lifecycle, complete access enforcement or reviewed commit gate. Scribe/registry behavior is deterministic simulation. The illustrative export lacks required document structure. Existing telemetry includes fixed values and cannot substantiate latency/concurrency targets. Clinical/legal/compliance claims in legacy comments and output remain unverified.

The API root's missing-preview fallback is corrected during repository setup. This does not implement the planned frontend.

## Separate or deferred

Insurer/TPA verification needs a separate purpose-specific authorization/release contract; it is outside the current OPD build. A clinician grant, public QR or emergency permission cannot authorize payer access. No automatic fraud, coverage or claim-eligibility verdict is established.

Inter-facility synchronization, general EHR scope, billing, dispensing and lab-result processing remain outside the core build. There is no live hospital, ABHA, ABDM, NMC, insurer or speech-provider integration.

## Evidence

The setup environment ran Python 3.12.14 on Windows: all 13 existing service tests passed. Dependency consistency and API entry points are checked during setup. These checks establish only the exercised legacy behavior and packaging. They do not establish the planned acceptance gates, clinical validity, security enforcement, resource targets or Linux behavior; consult the actual CI results for the latter.
