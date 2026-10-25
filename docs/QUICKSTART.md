# Run and use the MVP

This is a fictional-data prototype. Run these commands from the **App repository root** with Node.js 24 LTS and Git installed. No planning-workspace files are needed.

## First run

```powershell
npm ci
Copy-Item .env.example .env
npm run check:environment
npm run build
npm run manage -- init --db data/runtime/vellum.sqlite3 --seed opd-demo-v1
npm start
```

Copy `.env.example` only if `.env` does not already exist. On macOS/Linux use `cp .env.example .env`. Initialization privately prompts for a separate 12–128 character password for each fictional account below. Remember those passwords: no default password is published. Install, build and start never create the working database automatically.

Open **http://127.0.0.1:3000/**. Use that hostname consistently; the default Origin configuration uses `127.0.0.1`. Keep the terminal running; Ctrl+C stops the backend. Later runs need only `npm start`, plus `npm run build` after frontend changes. See [README](../README.md) for configuration and [operations](OPERATIONS.md) for backup/recovery.

If this existing Windows checkout uses the optional private portable runtime, run `. ./scripts/use-node.ps1` first. A fresh clone can use a normal Node 24 installation.

## Accounts and pages

| Username | Use |
| --- | --- |
| `staff` | Assigned-room queue, intake, calls, arrival and absence/recall workflows. |
| `doctor12`, `doctor18` | Respective assigned-room queue and checked-in clinical encounters. |
| `patient-a` through `patient-d` | Their own visit, sharing decisions and reviewed output. |

Sign in at `/login/`. Provider accounts open `/patients/`; patient accounts open `/patient-visit/`. Clinical Encounter opens from the clinician's current checked-in patient. Use separate browser profiles or separate browsers for simultaneous staff/clinician/patient sessions; tabs in one profile share cookies.

## Try the workflow

1. As staff, inspect the seeded queue or register a fictional local visit. Calling a patient and confirming arrival are separate actions. A fresh dataset includes staged queue checkpoints, so follow its current state rather than calling a second patient into an occupied room.
2. As the assigned clinician, open the current checked-in encounter. Request the needed record-sharing scopes. Arrival alone does not permit history access.
3. As the corresponding patient, choose **Allow**, **Deny** or **Ask Why** on Patient Visit. An allowance lasts at most 15 minutes and can be stopped. New-care manual notes remain usable without history access.
4. In Clinical Encounter, enter a manual note or choose a visibly simulated scribe example. Manual capture creates no automatic clinical items. Add any desired structured statements explicitly, then **Save draft → Review visit → Confirm review → Save reviewed record**. Editing requires saving and reviewing again.
5. With permission, use the six supported record questions and inspect the actual source citations. Missing information is not evidence of clinical absence. Optional checks currently return `NOT_EVALUATED`.
6. After the reviewed record is committed, the patient can deliberately view/print the summary and download their audit or local FHIR JSON. Completing the encounter is separate from saving the record and does not automatically call the next patient.

The seeded ledger example is bound to `doctor12` and `patient-a`. New local registration does not create a patient login. The current pages also contain staff-assisted sharing, print/download and language controls; fuller patient linking, complete translation and browser/hosted verification require checking against the latest [frontend evidence](../frontend/README.md). Assisted sharing must record the patient's actual choice, independently of the requesting clinician.

## Optional AI

Default setup requires no API key and makes no live AI calls. Voice is simulated/manual. The encounter page includes an optional six-topic text-interpretation choice and a consultation-brief proposal control; their local browser integration is checked with stubbed AI; hosted/live-model behavior still needs verification. A proposal must be deliberately used/edited, saved and reviewed before commit. To deliberately activate Sarvam text, follow [AI setup](AI.md), supply the key only in private server configuration and confirm actual positive promotional credit. `npm run ai -- status` checks readiness without calling the provider. Never commit `.env`, passwords, databases or credit confirmations. Credit confirmation expires; it is not a balance API or a guarantee of free usage.

## Checks and hosting

```powershell
npm test
```

Ordinary tests use disposable fictional storage and stubbed AI; they do not call Sarvam. Tests do not constitute clinical validation. The default database persists across ordinary restarts. Stop the server before maintenance; do not delete database sidecar files to resolve errors.

For hosting use the [Render guide](RENDER.md). Its repository configuration is prepared, but no Render service/disk has been provisioned or verified. Use synthetic data there too. Hosted cookies, persistence and the complete browser journey require deployment verification. Official FHIR validation remains `NOT_RUN`.
