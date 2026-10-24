# VaultMed / CharakVault

Fictional-data OPD prototype for assisted intake, queue/navigation, patient-controlled record access and clinician-reviewed documentation.

**Current milestone: durable queue/consent and reviewed clinical capture/history APIs.** Manual/scripted capture, versioned drafts, exact clinician review, one atomic commit, entity-based history and six cited questions now use the backend. Optional checks explicitly report unsupported coverage. Reviewed summary/FHIR output is next. Frontend work is separate; connected browser flows are not established by these API tests. See [implemented API](docs/API.md) and [actual evidence/next stages](docs/STATUS.md).

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
| `npm test` | Run setup/storage/recovery, real HTTP auth/queue/consent/capture/clinical/race checks, coordinators and browser helpers; output/browser TODOs remain explicit. |
| `npm start` | Verify the existing database/map/public files, then start one Express listener. Missing/invalid storage fails without creating a database. |
| `npm run manage -- --help` | Show implemented init/verify/backup/restore/reset options. |
| `npm run manage -- init --db data/runtime/vaultmed.sqlite3 --seed opd-demo-v1` | Privately prompt for fictional account passwords and explicitly initialize a new dataset. Matching existing initialization is a verified no-op. |
| `node tests/resource-run.js` | Exit nonzero; no benchmark or resource claim. |

After explicit initialization below, run `npm start`. The example configuration listens at http://127.0.0.1:3000. `GET /api/v1/health/live` reports process availability; `GET /api/v1/health/ready` checks current clock/storage readiness. Frontend pages are being developed separately and still need API/browser integration verification. `dist` is generated public output; no hosted deployment is established.

Implemented auth routes are `POST /api/v1/auth/login`, `GET /api/v1/auth/session` and `POST /api/v1/auth/logout`. POST requires JSON, the exact configured frontend Origin and a UUID X-Idempotency-Key; authenticated POST also requires the session's X-CSRF-Token. Login returns safe actor metadata, absolute expiry and page-memory CSRF. The opaque cookie is HttpOnly/SameSite=Strict/host-only and Secure except explicit loopback HTTP. GET session never renews the two-hour deadline. [API notes](docs/API.md) list the queue/navigation/patient-card/consent routes, versions, fields and role boundaries. Clinical query/capture/export and AI endpoints remain safe 404.

## Configuration and private data

`.env.example` documents PORT, HOST, FRONTEND_ORIGIN, API_ORIGIN, VAULTMED_DB_PATH, USE_MOCK_ASR, SARVAM_ENABLED, SARVAM_API_KEY and PUBLIC_API_BASE_URL. Keep `.env` private. Defaults use loopback HTTP, mock voice and disabled text AI. Do not paste provider keys into chat. No provider account, payment or request is needed for setup.

Only the parsed PUBLIC_API_BASE_URL enters browser configuration. Database/manifest paths are restricted to ignored data/runtime, data/backups, data/reports or data/test-runs directories; data/fixtures is for tracked credential-free source inputs. The seed contains four fictional patients, seven fixed accounts, rooms 12/18, waiting/current/absent checkpoints, penicillin-positive and discontinued-Ecosprin sources, and a scoped latex-negative source. No mental-health diagnosis is inferred. Capture supports three offline scripted examples or manual text, then save/exact review/one committed batch per encounter. Manual text creates no automatic items; simulated transcription processes no audio. Six exact clinical questions return source-cited, limited-vault evidence under current consent. Optional checks return NOT_EVALUATED because no sourced, clinician-reviewed interaction rules are installed. Reviewed summary/FHIR remains pending. Sample navigation is bilingual and supports step-free filtering, with no surveyed-accessibility claim. See [API contract](docs/API.md).

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

Verification checks actual SQLite >=3.51.3, WAL/FULL/FK/50 ms busy settings, schema definitions and append guards, database/FK integrity, queue/auth relationship invariants and canonical clinical chains. Ordinary reopen retains original deadlines. Real HTTP tests create/decide/revoke consent and exercise queue/closure, capture/review/commit, source corrections, clinical delivery/revocation, safe replay and restart. Reviewed output and real browser behavior remain pending. There is no auto-migration, auto-repair or absolute-immutability claim.

## Structure

| Path | Ownership |
| --- | --- |
| frontend/login, patients, encounter, patient-visit | Separate HTML/CSS/JavaScript page shells; no implemented workflows. |
| frontend/shared | Public configuration, Tailwind source, memory-only API/session helpers and text-safe DOM helpers. |
| backend and backend/services | Storage/auth/coordinators, queue/consent/navigation, capture/review/commit, cited clinical reads and canonical verification; summary/output remains unfinished. |
| data/fixtures | Validated fictional seed, optional offline-ASR registry and sample map. |
| data/runtime, backups, reports, test-runs | Private generated directories; ignored by Git and excluded from build. |
| assets | Public CSS/images/icons/fonts; generated Tailwind is ignored. |
| scripts | Build, environment verification and optional Windows runtime helper. |
| tests | Storage/recovery, HTTP auth/queue/consent/capture/clinical, coordinator races, browser helpers, canonical vectors, output/browser TODOs and unfinished resource runner. |
| docs and .github/workflows | App-owned status and setup CI; remote CI results require an actual run. |

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Hosted origins, cookies, TLS/proxy settings and persistence remain deployment work; there is no production identity, medical safety or compliance guarantee.
