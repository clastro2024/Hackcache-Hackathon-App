# VaultMed / CharakVault

Fictional-data OPD prototype for assisted intake, queue/navigation, patient-controlled record access and clinician-reviewed documentation.

**Start here: [run and use the MVP](docs/QUICKSTART.md)** — first initialization, account roles and the end-to-end workflow. Detailed setup and engineering status follow below.

**Current milestone: backend workflows, output and Sarvam integration.** Manual/scripted capture, exact review/commit, cited history, reviewed encounter summaries, local R4 downloads and own-patient audit history/checksums use the backend. Sarvam text routes are integrated, live-checked and locally enabled behind an expiring private credit confirmation. Render supports a private key/credit secret; no hosted deployment is established. Broader AI quality evaluation remains pending; see [AI setup/evidence](docs/AI.md). Official FHIR validation stays NOT_RUN. Frontend work is separate; connected browser flows are not established by API tests. See [implemented API](docs/API.md), [operations](docs/OPERATIONS.md) and [actual evidence/next stages](docs/STATUS.md).

## Setup

Install [Node.js 24 LTS](https://nodejs.org/en/download) and Git. This repository works independently of the planning workspace.

```powershell
node --version
npm --version
npm ci
Copy-Item .env.example .env
npm run check:environment
npm run build
npm test
```

Copy the example only when `.env` does not already exist; preserve private local settings. In a fresh macOS/Linux clone, use `cp .env.example .env` instead. Existing process environment overrides the explicitly loaded `.env` through Node's native `--env-file-if-exists` support.

If this Windows checkout has a private portable Node under `.tools`, `. ./scripts/use-node.ps1` selects it for the current PowerShell session. It is optional, ignored by Git and not required in a fresh clone. A system Node 22 installation does not satisfy this project's engine requirement.

The exact eight direct packages and their transitive dependencies are locked. `.npmrc` disables dependency install scripts: these pinned native packages ship prebuilt binaries. This avoids an observed implicit node-gyp build failing on a missing Windows SDK. `check:environment` actually loads SQLite and Argon2, verifies SQLite >=3.51.3, probes Argon2id hash/verify and checks package versions. Unsupported prebuild/platform combinations must fail this check; skipping scripts alone is not compatibility evidence. No compiler, Python environment or AI SDK is an application prerequisite for the verified setup.

## Commands

| Command | Current behavior |
| --- | --- |
| `npm ci` | Reproduce dependencies from package-lock.json, including build dependencies. |
| `npm run check:environment` | Check Node 24, locked package versions, native SQLite and Argon2id; memory-only probe, no application database. |
| `npm run build` | Compile shared Tailwind and assemble public page shells/shared modules/assets in dist. |
| `npm test` | Run storage/recovery, real HTTP workflows/output/audit/races, telemetry, actual forced drain and stubbed text-AI tests. Browser/hosted/physical-fault TODOs remain explicit. |
| `npm start` | Verify the existing database/map/public files, then start one Express listener. Missing/invalid storage fails without creating a database. |
| `npm run manage -- --help` | Show implemented init/verify/backup/restore/reset options. |
| `npm run ai -- status` | Check AI configuration/key presence/credit-file expiry; no database or provider call. |
| `npm run ai -- credit --balance-inr <verified-amount> --hours 24` | Explicit private operator credit confirmation; add --replace only after a new balance check. |
| `npm run deploy:check` | Check HTTPS/single-worker/runtime-disk/mock-voice and optional gated-text deployment configuration without initializing storage or making a provider call. |
| `npm run deploy:start` | Start the prepared Render candidate against an existing database, with a 25-second drain limit. |
| `npm run manage -- init --db data/runtime/vaultmed.sqlite3 --seed opd-demo-v1` | Privately prompt for fictional account passwords and explicitly initialize a new dataset. Matching existing initialization is a verified no-op. |
| `npm run resource:smoke` | Exercise the owned-process resource harness briefly; targets remain UNAVAILABLE. |
| `npm run resource:profile` | Private sampled allocation diagnostic; targets remain UNAVAILABLE. |
| `npm run resource:run` | Run the paced resource-small-v1 workload for about five minutes with the serving runtime policy and save a private report. No-argument invocation refuses to run. |

After explicit initialization below, run `npm start`. The example configuration listens at http://127.0.0.1:3000. `GET /api/v1/health/live` reports process availability; `GET /api/v1/health/ready` checks current clock/storage readiness. Frontend pages are being developed separately and still need API/browser integration verification. `dist` is generated public output; no hosted deployment is established.

Implemented auth routes are `POST /api/v1/auth/login`, `GET /api/v1/auth/session` and `POST /api/v1/auth/logout`. POST requires JSON, the exact configured frontend Origin and a UUID X-Idempotency-Key; authenticated POST also requires the session's X-CSRF-Token. Login returns safe actor metadata, absolute expiry and page-memory CSRF. The opaque cookie is HttpOnly/SameSite=Strict/host-only and Secure except explicit loopback HTTP. GET session never renews the two-hour deadline. [API notes](docs/API.md) list the implemented clinical, queue, consent, telemetry and optional text routes. Legacy bypass routes remain unavailable.

## Configuration and private data

`.env.example` documents PORT, HOST, FRONTEND_ORIGIN, API_ORIGIN, VAULTMED_DB_PATH, USE_MOCK_ASR, SARVAM_ENABLED, SARVAM_API_KEY, SARVAM_ACCESS_FILE and PUBLIC_API_BASE_URL. Keep `.env` private. Public defaults use loopback HTTP, mock voice and disabled text AI; the operator's current local configuration enables verified gated text. Do not paste provider keys into chat. No provider account, payment or request is needed for the default setup.

Only the parsed PUBLIC_API_BASE_URL enters browser configuration. Database/manifest paths are restricted to ignored data/runtime, data/backups, data/reports or data/test-runs directories; data/fixtures is for tracked credential-free source inputs. The seed contains four fictional patients, seven fixed accounts, rooms 12/18, waiting/current/absent checkpoints, penicillin-positive and discontinued-Ecosprin sources, and a scoped latex-negative source. No mental-health diagnosis is inferred. Capture supports three offline scripted examples or manual text, then save/exact review/one committed batch per encounter. Manual text creates no automatic items; simulated transcription processes no audio. Six exact clinical questions return source-cited, limited-vault evidence under current consent. Optional checks return NOT_EVALUATED because no sourced, clinician-reviewed interaction rules are installed. Sample navigation is bilingual and supports step-free filtering, with no surveyed-accessibility claim. See [API contract](docs/API.md).

Reviewed summary/FHIR routes use only the committed encounter batch and reject later-corrected sources. Clinician output requires current patient-approved summary:export; own-patient output continues after closure. One shared build slot and a 1 MiB complete-output cap apply. The limited Composition-first local R4 mapping supports prescriptions/conditions and retains other statements narratively; application preflight is not official validation, ABDM conformance or a signature. Own-patient audit downloads include their release audit, fixed complete bound, chain-check result and exact canonical-content SHA-256 checksum. The standalone integrity route is patient-only; a detected mismatch reports FAIL without clinical values.

Optional Sarvam text routes classify a question into one supported local topic or propose sections from saved notes. The backend supplies evidence; generated prose never commits itself. Notes-only drafting needs no history grant; including history requires current consent before sending, storing and delivering. One in-flight call, durable three/minute and thirty/dataset reservation limits, bounded context/output and no automatic provider retry apply. Enabled configuration and a fresh private operator confirmation are both required. The ai credit command writes it only on explicit operator input; ordinary setup/tests never do. Live smoke uses an isolated temporary file. Missing/expired credit disables AI while manual/local functions continue. It is not an automatic balance check or guarantee of free usage. Voice stays simulated/manual; see AI.md for activation/renewal and actual results.

The default working database is not initialized by install/build/test. Explicit initialization requires a private password for each fixed username: staff, doctor12, doctor18 and patient-a through patient-d. Passwords are 12–128 characters, hashed with Argon2id outside transactions, and never written into fixtures or receipts. The CLI prompts without echo; private automation may pass a bounded username/password JSON map through stdin with --passwords-stdin. Never put passwords in arguments, committed files or chat. Initialization creates no sessions or grants. Source dates remain source dates; actual initialization binds event recording time before hashing and records its own audit.

## Stopped maintenance

All maintenance and the backend hold the same cooperative per-file process lease. Stop the backend before running maintenance; a live or unknown lease owner is refused. Dead-process leases can be recovered without killing another process or deleting WAL/SHM files. This is coordination for cooperating entrypoints, not protection against a privileged host operator.

```powershell
npm run manage -- verify --db data/runtime/vaultmed.sqlite3
npm run manage -- backup --db data/runtime/vaultmed.sqlite3 --out data/backups/opd-baseline.sqlite3
npm run manage -- restore --backup data/backups/opd-baseline.sqlite3 --new-db data/runtime/restored-001.sqlite3
npm run manage -- reset --db data/runtime/vaultmed.sqlite3 --new-db data/runtime/fictional-002.sqlite3 --seed opd-demo-v1
```

Outputs must be new paths. Backup uses SQLite's backup API, verifies a standalone DELETE-journal candidate and writes its checksum/counts/clinical-head manifest beside it; the source remains WAL. Restore checks the manifest/checksum/schema/runtime/chains, creates a separate WAL file, revokes recovered sessions, cancels pending requests, ends active grants and assigns a new dataset ID without rewriting clinical events. It pauses rooms for staff reconciliation of the recovered checkpoint. It does not switch .env automatically. Reset first creates a verified backup, preserves the old database and initializes a separate fictional dataset with new private passwords.

Verification checks actual SQLite >=3.51.3, WAL/FULL/FK/50 ms busy settings, schema definitions and append guards, database/FK integrity, queue/auth relationship invariants and canonical clinical chains. Ordinary reopen retains original deadlines. Real HTTP tests exercise consent, queue/closure, exact review/commit, corrections, protected output, audit checksums, delivery/expiry/revocation races, safe replay, restart and output from a restored committed batch. Official FHIR validation and real browser behavior remain pending. There is no auto-migration, auto-repair or absolute-immutability claim.

## Structure

| Path | Ownership |
| --- | --- |
| frontend/login, patients, encounter, patient-visit | Separately developed HTML/CSS/JavaScript pages; browser workflow verification remains separate. |
| frontend/shared | Public configuration, Tailwind source, memory-only API/session helpers and text-safe DOM helpers. |
| backend and backend/services | Storage/auth/coordinators, queue/consent/navigation, capture/review/commit, cited reads, reviewed summary/local R4 and own-patient audit output. |
| data/fixtures | Validated fictional seed, optional offline-ASR registry and sample map. |
| data/runtime, backups, reports, test-runs | Private generated directories; ignored by Git and excluded from build. |
| assets | Public CSS/images/icons/fonts; generated Tailwind is ignored. |
| scripts | Build, environment verification and optional Windows runtime helper. |
| tests | Storage/recovery, HTTP workflows/output/audit, coordinator races, browser helpers, canonical vectors, stubbed AI, telemetry, forced drain and the explicit owned-process resource runner. |
| docs and .github/workflows | App-owned status and setup CI; remote CI results require an actual run. |

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Hosted origins, cookies, TLS/proxy settings and persistence remain deployment work; there is no production identity, medical safety or compliance guarantee.

[Render preparation](docs/RENDER.md) includes a schema-validated paid single-service/disk candidate, explicit private first initialization of fictional data and stopped runtime maintenance. Repository configuration is prepared; the service/disk has not been provisioned or tested on Render. Frontend–backend integration remains deferred. The user accepted **89.24 MB local peak RSS** and stopped further peak tuning; [MEMORY.md](docs/MEMORY.md) records every retained approach, the rejected experiment and final results. Serving, deployment, tests and resource npm scripts select a 1 MiB V8 nursery semi-space, without capping old-space or forcing GC; see [runtime tradeoffs and measured limits](docs/OPERATIONS.md#resource-run). Optional `npm run resource:profile` establishes no performance target and adds no public profiler.
