# App repository instructions

This is the independent VaultMed / CharakVault application repository. Preserve unrelated work. Read README.md and docs/STATUS.md for actual implementation status.

- Node.js 24 LTS, JavaScript ES modules, Express 5, better-sqlite3, strict Zod, argon2, cookie and helmet. HTML/Tailwind/vanilla JavaScript; no ORM, bundler, additional backend or AI SDK.
- Current milestone includes setup/storage/auth, step-3 queue/consent and step-4 manual/scripted capture, drafts, exact review/commit, entity projection, cited history/query and voluntary NOT_EVALUATED checks. Reviewed summary/FHIR output, connected browser flows and hosting remain unfinished. See docs/API.md and docs/STATUS.md; HTTP tests do not complete browser/application acceptance. Preserve concurrent frontend work.
- One backend process, one database connection and one transaction owner. Keep business/audit/receipts atomic; no network, asynchronous wait or password hashing inside transactions.
- Fixed fictional accounts; opaque server-side cookie sessions and CSRF. Server-bound role/object permission and consent are separate. Maxima: sessions 7200 seconds, requests 300 seconds, encounter grants 900 seconds.
- Authenticate/authorize before matching a safe receipt; new-action version/state guards follow receipt matching. Preserve X-Idempotency-Key intent on retries.
- Clinical history appends; corrections supersede. Preserve the v1 canonical bytes and source/review provenance. Missing information never proves absence or clinical safety. Review the exact draft before commit.
- All persistent data belongs under data. Only frontend/assets may enter dist. Never serve the repository root, environment, database, backups, reports or test data. Keep credentials/clinical contents out of logs and Git.
- SARVAM_ENABLED defaults false. No provider calls during install/build/start/test. Live text requires verified promotional credit/key/access and explicit scope; no paid fallback or live speech.
- Run affected checks from this repository: npm run check:environment, npm run build, npm test. Functional acceptance TODOs remain NOT_RUN. Never relabel historical Python results as JavaScript evidence.
- Native packages currently use shipped prebuilds with install scripts disabled in .npmrc. Verify actual bindings after a lockfile/dependency/platform change. Do not silently enable source builds or install a global toolchain.
- Keep setup self-contained. App owns its source, lockfile, documentation and CI; the surrounding workspace is a separate repository. Do not commit, push or publish without instruction.
- Do not spawn subagents unless explicitly requested. Keep scope viable for two people in 48 hours.
