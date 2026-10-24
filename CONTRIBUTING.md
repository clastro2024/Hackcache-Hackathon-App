# Contributing

Use Node.js 24 LTS and the README setup. Run commands from this independent app repository. Public setup must not require planning files from a surrounding repository.

## Checks and scope

```powershell
npm ci
npm run check:environment
npm run build
npm test
```

Tests exercise actual private files, transactions, an owned child process, local HTTP listeners and browser request/session helpers. Coordinator races use constructor hooks outside transactions; no HTTP test-control routes exist. Consent/grant rows used by auth tests are explicitly inserted fictional fixtures, not evidence of consent endpoints. Test names identify the exercised portion of Q/S/D/A/C/ASR/F/R; passing a portion does not complete an acceptance gate. Node cookie adapters do not verify browser cookie enforcement. Remaining domain suites stay TODO. Tests and CI never make live Sarvam calls; resource measurement remains separate.

tests/fixtures/v1-vectors.json contains six fixed byte/hash references generated with Python 3.14 during development and checked by JavaScript tests, including the published 1,090-byte vector. Python is not an install, CI or application dependency. The v1 encoder preserves sorted Unicode keys, UTF-8 compact JSON, integer sequence and Python float representation for nullable capture.confidence. Do not substitute plain JSON.stringify or silently rewrite stored bytes/hashes. Initialization binds fresh recording times; restore retains the already committed canonical text.

One package.json and package-lock.json own all dependencies. Preserve exact compatible pins; use npm ci for reproduction. When intentionally upgrading, review actual package API/native/platform changes and lockfile integrity, recheck native bindings and build, and record results. .npmrc currently disables install scripts because pinned native packages include prebuilds; do not claim an untested platform works or silently add global compiler prerequisites.

## Repository and data boundaries

App source, fixtures, documentation, tests and CI belong here. Inspect `git status` before changes; preserve other contributors' work. Use task branches when instructed, stage exact files, and inspect the staged diff. Do not force-add this repository to a parent, reinitialize Git, discard history or commit/push/publish without authorization.

Keep .env, .tools, node_modules, runtime databases/WAL/SHM, backups, reports, test data, dist and generated CSS private or ignored as appropriate. Fictional fixture inputs contain no passwords, keys, active sessions or real records. Do not print protected content or environment dumps in debugging output.

## Implementation order

1. Completed storage foundation: thirteen tables, synchronous units, safe audit/receipts, real fictional fixtures, v1 canonical vectors and explicit maintenance. Broader application acceptance remains pending.
2. Completed server/auth foundation: existing-file startup, current readiness, bounded shutdown, fixed-account login/session/logout, Origin/CSRF, permission and command/release coordinators, memory-only browser helpers. Hosted/browser and domain-route acceptance remain pending.
3. Next: intake/queue/navigation, encounter binding and consent.
4. Capture/save/edit/review/commit, cited evidence and optional local checks.
5. Bounded optional text AI and source-checked reviewed summary/local FHIR output.
6. Real integration/recovery/browser/packaging checks, then scoped resource measurement.

Keep one backend/database authority, no asynchronous work in transactions, no successful placeholder endpoints and no clinical commit from extraction alone. Reconcile uncertain operations using the original key and intent. Record implemented behavior separately from proposed controls after each stage.
