# Contributing

Use Node.js 24 LTS and the README setup. Run commands from this independent app repository. Public setup must not require planning files from a surrounding repository.

## Checks and scope

```powershell
npm ci
npm run check:environment
npm run build
npm test
```

Tests exercise actual private files, transactions, an owned child process, local HTTP auth/queue/consent/capture/clinical/output/audit listeners and browser helpers. Coordinator pauses use constructor hooks outside transactions; no HTTP test-control routes exist. Older auth/coordinator fixtures still insert labelled consent rows; domain HTTP tests separately create real approvals, drafts, reviews/commits, corrections, output, audit bounds and closures. Test names identify exercised Q/S/D/A/C/ASR/F/R portions; passing one portion does not complete an acceptance gate. Node cookie adapters do not verify browser cookie enforcement. Browser/printing, hosted/runtime and AI gates stay TODO; official FHIR validation remains NOT_RUN. Tests never make live Sarvam calls; resource measurement remains separate.

tests/fixtures/v1-vectors.json contains six fixed byte/hash references generated with Python 3.14 during development and checked by JavaScript tests, including the published 1,090-byte vector. Python is not an install, CI or application dependency. The v1 encoder preserves sorted Unicode keys, UTF-8 compact JSON, integer sequence and Python float representation for nullable capture.confidence. Do not substitute plain JSON.stringify or silently rewrite stored bytes/hashes. Initialization binds fresh recording times; restore retains the already committed canonical text.

One package.json and package-lock.json own all dependencies. Preserve exact compatible pins; use npm ci for reproduction. When intentionally upgrading, review actual package API/native/platform changes and lockfile integrity, recheck native bindings and build, and record results. .npmrc currently disables install scripts because pinned native packages include prebuilds; do not claim an untested platform works or silently add global compiler prerequisites.

## Repository and data boundaries

App source, fixtures, documentation, tests and CI belong here. Inspect `git status` before changes; preserve other contributors' work. Use task branches when instructed, stage exact files, and inspect the staged diff. Do not force-add this repository to a parent, reinitialize Git, discard history or commit/push/publish without authorization.

Keep .env, .tools, node_modules, runtime databases/WAL/SHM, backups, reports, test data, dist and generated CSS private or ignored as appropriate. Fictional fixture inputs contain no passwords, keys, active sessions or real records. Do not print protected content or environment dumps in debugging output.

## Implementation order

1. Completed storage foundation: thirteen tables, synchronous units, safe audit/receipts, real fictional fixtures, v1 canonical vectors and explicit maintenance. Broader application acceptance remains pending.
2. Completed server/auth foundation: existing-file startup, current readiness, bounded shutdown, fixed-account login/session/logout, Origin/CSRF, permission and command/release coordinators, memory-only browser helpers. Hosted/browser and domain-route acceptance remain pending.
3. Completed backend APIs: intake/queue/navigation, encounter binding/check-in, ALLOW/DENY/ASK WHY, clarification/revoke and scoped emergency access. Connected pages/browser acceptance remain pending. See docs/API.md.
4. Completed backend capture/save/edit/exact review/commit, entity projection, cited evidence and optional NOT_EVALUATED checks. New care is independent of history sharing; prior-source edits require current source access. No live ASR or clinical safety claim.
5. Completed backend source-checked reviewed summary/local R4 output and patient audit history/integrity/download. Official FHIR validation remains NOT_RUN; no signature/profile/exchange claim.
6. Next: connect/verify browser flows and downloads/printing, select hosted topology/persistence, then scoped resource measurement. Optional text AI requires verified free credit/key/access and does not block manual/offline care.

Keep one backend/database authority, no asynchronous work in transactions, no successful placeholder endpoints and no clinical commit from extraction alone. Reconcile uncertain operations using the original key and intent. Record implemented behavior separately from proposed controls after each stage.
