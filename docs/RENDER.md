# Render deployment candidate

Prepared for the independent App repository on `main`. No Render service, disk, payment or domain has been created by this preparation. Local page/API integration and stubbed browser checks passed; final frontend acceptance and hosted verification remain separate. The Blueprint selects credit-gated Sarvam text with a private key prompt and operator-supplied credit secret file. This is a reviewable configuration, not proof that the application has run on Render.

## Prepare now; deploy after final frontend acceptance

1. Sign in to Render and connect GitHub with access to `clastro2024/Hackcache-Hackathon-App`. Use this repository's `main` branch and root `render.yaml`; leave Root Directory blank. The Blueprint now explicitly pins `main` and keeps automatic deploys off.
2. Review the paid single-service/1 GB disk setup and current dashboard price before creating resources. Singapore is selected. Use the provided `onrender.com` URL initially; a custom domain is optional. No separate frontend/static service or Postgres database is required for this SQLite MVP.
3. Prepare seven independent fictional-account passwords in a password manager. At deployment, supply the private `vellum-passwords.json` secret file described below. Do not upload the local preview database, preview credentials file or `.env`.
4. Have the Sarvam key ready privately. Generate its credit confirmation only near deployment, after a fresh dashboard check; confirmations expire within 24 hours. The current Blueprint needs both the private API key and the separate `sarvam-free-access.json` secret for live text. Offline operation is possible by deliberately selecting `SARVAM_ENABLED=false`.
5. When the final frontend changes are pushed to `main`, follow the first-initialization sequence below. Use `npm run deploy:initialize` once, then restore `npm run deploy:start` and remove only the bootstrap password secret. Keep the separate credit secret while using AI.
6. Before sharing the URL, check login/independent-profile consent, queue, exact review/commit, downloads and restart persistence. This final hosted check cannot be completed before the service exists.

Current repository preparation adds no deployment SDK/framework, no automatic seed/reset and no provider calls. Creating the service/disk incurs charges; do not click Deploy Blueprint merely to connect the account before you intend to provision resources. [Blueprint setup](https://render.com/docs/infrastructure-as-code), [persistent disks](https://render.com/docs/disks), [private secrets](https://render.com/docs/configure-environment-variables#secret-files).

Preparation check on 25 October 2026: the main-pinned Blueprint passed Render's current official JSON Schema validation. The affected deployment-admission test passed 1/1 (531.8753 ms total native run), with no database initialization or provider call. The private Python validator is an existing development-only tool, not a deployment dependency. No runtime source or dependency changed in this preparation; no Render resource was created.

## What is ready, and what "unapplied" means

The repository-side deployment setup is prepared: render.yaml, the Node pin, locked dependencies, native-binding/build checks, same-origin public pages/API, start/health/drain handling, private database path, explicit fictional-data initialization and stopped backup/restore commands. Local deployment lifecycle tests and Blueprint schema validation passed. No additional backend deployment framework is planned for this selected topology.

"Unapplied" means nobody has yet connected this configuration to a Render service, provisioned its disk or run the application there. It does not mean the deployment files are absent. Repository preparation cannot establish the outcome of a first hosted build or disk/browser check.

After final frontend acceptance, the path is:

1. Commit/push the reviewed **App repository's main branch**, then connect that repository/branch through Render's New > Blueprint flow using its root render.yaml. This is deployment of the full Node application, not a static-file upload. [Blueprint setup](https://render.com/docs/infrastructure-as-code#setup).
2. Provision the configured single service/runtime disk and supply the private fictional-account password file described below.
3. Run the one-time `npm run deploy:initialize`, switch back to `npm run deploy:start`, and remove the bootstrap secret file.
4. Verify readiness, login, the integrated journey, restart persistence and recovery on the actual hosted URL.

Those deployment steps are already specified and supported by code. They are still required: selecting normal startup on an empty disk intentionally refuses the missing database. "Ready to deploy" therefore means prepared repository configuration plus documented first-run setup, not a guarantee that an untested upload will immediately work.

## Synthetic-data scope

The user confirmed on 24 October 2026 that Render will use synthetic data only. deploy:initialize already selects the **opd-demo-v1** fictional seed from tracked data/fixtures/seed.json, with the sample map and offline-ASR registry. The standard seed has four fictional patients, seven fixed accounts and rooms 12/18; the twenty-patient resource fixture is test-only and is not silently substituted as the hosted seed. Initial account passwords are supplied privately and hashed, not embedded in the public fixtures.

Do not upload a working local SQLite file or .env as deployment assets. Initialization creates the fictional database on the Render runtime disk; later starts retain queue actions, records, consent deadlines and the dataset identity. Synthetic data still uses normal server-side accounts, CSRF, consent, review and audit. It does not enable live AI, remove access controls or make the filesystem persistent. The selected disk-backed configuration is paid; without a persistent disk Render's local changes are lost on restart/redeploy. [Persistent disk behavior](https://render.com/docs/disks).

## Selected candidate

One native Node service serves the existing public pages/assets and /api/v1 at the same HTTPS origin. One process owns one SQLite connection/file. This fits the host-only SameSite=Strict cookie policy without adding cross-site cookies or proxy trust. No extra frontend service, database service, replica or autoscaler is configured.

[render.yaml](../render.yaml) selects Singapore, the 0.5c-512mb paid compute plan, one instance and a 1 GB persistent disk. **Applying it incurs compute/disk charges; review current pricing before provisioning.** Persistent disks require paid compute; the free ephemeral filesystem cannot preserve this SQLite dataset across restarts. There is no automatic fallback to ephemeral storage or another database. [Render disks](https://render.com/docs/disks), [Blueprint reference](https://render.com/docs/blueprint-spec).

| Setting | Candidate |
| --- | --- |
| Repository | App's independent Git repository, main branch; root directory blank, not App |
| Runtime | Node 24.22.1, also pinned in .node-version |
| V8 nursery | Serving npm commands select --max-semi-space-size=1; no old-space/RSS cap or forced GC; see OPERATIONS.md |
| Build | npm ci --include=dev && npm run check:environment && npm run build |
| Normal start | npm run deploy:start |
| Health path | /api/v1/health/ready |
| Listener | HOST=0.0.0.0; Render-supplied PORT (usually 10000) |
| Storage mount | /opt/render/project/src/data/runtime |
| Database | data/runtime/vellum.sqlite3 |
| Frontend/API origin | Both alias this service's RENDER_EXTERNAL_URL |
| Public API base | /api/v1 |
| Workers | WEB_CONCURRENCY=1; numInstances=1 |
| AI/voice | SARVAM_ENABLED=true; private SARVAM_API_KEY prompt; USE_MOCK_ASR=true |
| Credit gate | SARVAM_ACCESS_FILE=/etc/secrets/sarvam-free-access.json; supply/renew the operator confirmation below |
| Automatic deploys | Off; choose a reviewed commit deliberately |

Mount runtime rather than all of data: mounting data would hide the tracked fixtures/map. Store hosted backups under data/runtime/backups and persistent reports under data/runtime/reports. data/backups and data/reports outside that mount remain ephemeral on this candidate. Only frontend/assets or public dist belong in static hosting; do not publish the repository root. Native packages retain the lockfile and disabled install scripts; the build checks actual SQLite/Argon2 bindings rather than assuming Linux compatibility. [Node version selection](https://render.com/docs/node-version), [default environment variables](https://render.com/docs/environment-variables).

## Provisioning and explicit first initialization

1. Review the paid candidate and current pricing, then use this repository's render.yaml in Render. Nothing in this preparation applies it. Keep automatic deploys off. The first normal launch intentionally refuses a missing database; this is not permission to auto-seed during restart.
2. In the Render service's Environment page, add a secret file named vellum-passwords.json. Its contents must be a strict JSON object with exactly the seven usernames staff, doctor12, doctor18 and patient-a through patient-d, each mapped to a private 12–128-character password. Use independent fictional-account passwords. The complete file must be <=8 KiB. Do not paste it in Git, command arguments, chat or logs. Render exposes it at /etc/secrets/vellum-passwords.json; remove it after initialization. [Secret files](https://render.com/docs/configure-environment-variables#secret-files).
3. For this first initialization only, temporarily set Start Command to `npm run deploy:initialize`, then deploy the reviewed build. This explicit command validates deployment configuration, reads the bounded private file, initializes a new fictional database and starts the normal protected listener. It refuses an existing database and never overwrites/reuses it as a new seed. A failed initialization/deploy must be inspected, not automatically retried as a reset.
4. Immediately change Start Command back to `npm run deploy:start`, remove the initialization secret file, and deploy again. Confirm readiness and persistence. Leaving the initialization command selected will fail on ordinary restart because the database already exists; changing back is required. Do not put initialization in buildCommand, preDeployCommand or initialDeployHook.
5. Confirm the two origin aliases resolved to the same exact HTTPS service URL. If using a custom domain, explicitly set FRONTEND_ORIGIN and API_ORIGIN to that same origin and deploy; do not derive authority from request Host/forwarded headers. PUBLIC_API_BASE_URL stays /api/v1. The candidate requires mock voice, one worker and a database path under the runtime mount. Enabled text needs a server key; actual requests additionally need the valid credit file below. `npm run deploy:check` checks configuration without opening/creating a database or contacting a provider; CREDIT_GATED does not prove available credit or a mounted disk.
6. Complete the hosted checks below before treating the URL as validated. Local page/API integration is checked; a healthy hosted backend alone does not establish the hosted patient journey.

scripts/render-start.js has no unauthenticated initialization route, default credentials or implicit seed-on-missing behavior. Initialization credentials are not retained by the app as a file or receipt; their Argon2 hashes belong in SQLite. JavaScript strings cannot be reliably erased from process memory. The one-time command's buffer is cleared after hashing, and ordinary serving needs no bootstrap secret.

## Sarvam text activation

1. Supply SARVAM_API_KEY through Render's private environment prompt (sync:false in the Blueprint). Never put its value into Git, HTML, a public build variable or logs. The Blueprint selects SARVAM_ENABLED=true; to run wholly offline, deliberately set it false in the reviewed Blueprint/service configuration.
2. After verifying positive promotional credit in the Sarvam dashboard, run `npm run ai -- credit --balance-inr <actual-verified-amount> --hours 24` locally. Add --replace only when deliberately replacing an existing confirmation. This creates private data/runtime/sarvam-free-access.json, containing confirmation metadata and no API key.
3. Add a Render secret file named **sarvam-free-access.json** containing that generated JSON. Its fixed runtime path is /etc/secrets/sarvam-free-access.json, already selected by SARVAM_ACCESS_FILE. Keep this credit file available; it is separate from the temporary vellum-passwords.json database-bootstrap secret, which must still be removed after initialization. [Render secret files](https://render.com/docs/configure-environment-variables#secret-files).
4. Deploy/restart after setting private environment or secret files. Missing/expired/invalid credit disables provider requests while manual/queue/local functionality stays usable. Renew only after another actual dashboard credit check, then replace the secret-file contents and deploy. The timestamp lifetime is at most 24 hours; there is no automatic renewal or paid fallback.

Admission accepts enabled text with a configured server key. It does not claim a valid balance just because a key is present. No startup/health/build/ordinary test calls Sarvam. One in-flight call, three/minute and thirty/dataset durable reservations, source/consent gates and clinician review remain unchanged. No hosted Sarvam call has been tested yet; see AI.md for local results. A hosted key/credit setup is required in addition to the database's synthetic account setup.

## Stopped maintenance and recovery

The cooperative database lease refuses maintenance while a live/unknown owner holds it. Render's disk is available only at runtime, not build/pre-deploy/one-off jobs. For this candidate, deliberately deploy with a temporary maintenance Start Command. The disk-backed old instance stops before the new instance uses the disk; the command completes maintenance before starting the listener. Expect downtime. [Disk lifecycle limitations](https://render.com/docs/disks#disk-limitations-and-considerations).

Render leases use the platform instance ID and Linux process identity so that an older container's persisted PID cannot block replacement startup. The server and stopped-maintenance entrypoints in the same instance still share one lease. Historical lease files are retained; no database reset or manual lock deletion is required. See [startup troubleshooting](RENDER_TROUBLESHOOTING.md).

Example temporary Start Commands:

```text
npm run deploy:maintenance -- verify
npm run deploy:maintenance -- backup --out data/runtime/backups/checkpoint-001.sqlite3
```

Use a new backup path each time. Change Start Command back to `npm run deploy:start` after success. The wrapper suppresses management result contents in service logs; failure emits a safe code and does not open a listener. It accepts only verify, backup and restore, preserving the existing CLI/path/lease checks. Ordinary local management commands stay independent of browser settings.

For restore, retain the old database and backup/manifest. Set VELLUM_DB_PATH to a new runtime file, and temporarily select, for example:

```text
npm run deploy:maintenance -- restore --backup data/runtime/backups/checkpoint-001.sqlite3 --new-db data/runtime/restored-001.sqlite3
```

The new path must match the configured database path. Restore verifies the checkpoint, writes a new dataset branch, ends recovered authorization and pauses queues for staff reconciliation. A missing/corrupt backup or existing destination fails safely; never delete WAL/SHM or overwrite a file to make it start. Change back to normal start after success. Keep a verified backup/manifest off the service disk using an authorized private transfer. Provider disk snapshots are not a replacement for the application-verified SQLite backup/recovery procedure.

The Render entrypoint drains for 25 seconds before aborting remaining work/connections, leaving time before Render's documented 30-second termination window. Normal local start retains a thirty-second default. Disk-backed services cannot customize the platform window or use zero-downtime deploys. Native local tests cover actual held-request branches; platform signal delivery remains a hosted check.

## Verification before sharing a working URL

Local checks are recorded in [STATUS.md](STATUS.md): real deployment admission, explicit initialization, secure-cookie configuration, missing-file refusal, ordinary reopen, maintenance/recovery, drain tests and canonical/hash compatibility. render.yaml was parsed and validated against Render's official JSON Schema; this is structural validation, not an account-side apply. One-off local Python validation tools are isolated under ignored .tools; Python is not an app/setup/CI requirement.

After provisioning, verify actual Linux native build, disk mount/writability, HTTPS and ready/live endpoints, exact origins/CORS/CSRF, Secure/HttpOnly/Strict cookies in independent browser profiles, and private-path/static exclusions. Record a synthetic mutation, restart/redeploy, then confirm it survives with original session/grant deadlines and dataset identity. Exercise explicit backup/restore and access invalidation on a disposable hosted dataset; verify SIGTERM behavior. Observe hosted RSS/latency without reopening the user-closed local peak-tuning task; the accepted 89.24 MB Windows result is not a Linux cap. Frontend integration must separately verify clearing, late results, consent, queue polling, review and downloads/printing. Verify hosted AI with the private key/credit file above and confirm expired credit preserves manual/local operation. See AI.md. Official FHIR validation remains NOT_RUN in this slice.

This candidate provides no production identity/privacy/compliance guarantee or hosted performance claim. Local RSS/latency results are reported with their actual workload and limits.
