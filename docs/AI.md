# Sarvam text integration and live evidence

Standing backend integration is implemented and local configuration is **enabled / READY** as of 25 October 2026. The user-confirmed pre-test balance was 100 promotional credits; the saved key stays private. The credit confirmation preserves its original verification timestamp and expires **25 October 2026 at 23:55 IST**. It is not an assertion of the post-test balance. No working database was initialized or ordinary backend listener started by this task. Voice stays simulated/manual.

Both existing HTTP routes now use a bounded private credit-file reader, and Render admission supports the same gated adapter. The reviewed Blueprint selects live text with a private key prompt and a separate Render secret file; no hosted service has been created. Public .env.example still defaults to disabled text AI.

## Existing scope

- POST /api/v1/ai/records/ask sends the question, not the patient's vault, to sarvam-105b for one of six supported topic keys. The backend supplies the actual source-cited answer and three-state evidence interpretation.
- POST /api/v1/ai/consultation/brief organizes saved fictional notes into a draft proposal. Sending history additionally requires current vault:query consent. The normal exact clinician review/commit path remains required.

The adapter uses native fetch, the fixed V1 Chat Completion endpoint, strict app-owned JSON Schema, temperature 0, reasoning_effort null, max_tokens 1024, n 1 and nonstreaming output. Local schema/source checks still apply. There is no additional SDK, agent, vector store or live speech adapter. [Sarvam V1 reference](https://docs.sarvam.ai/api-reference/chat/chat-completions-v1).

## Standing setup and renewal

Use the normal database initialization/login/encounter/consent workflow before invoking AI. No public activation or credit-writing API exists. The operator commands work without browser origin configuration, initialize no database and make **zero provider calls**:

```powershell
npm run ai -- status
npm run ai -- credit --balance-inr <actual-verified-positive-amount> --hours 24
```

Set the private SARVAM_ENABLED=true and SARVAM_API_KEY locally. SARVAM_ACCESS_FILE defaults to data/runtime/sarvam-free-access.json. Only App-private runtime/test paths or the fixed /etc/secrets/sarvam-free-access.json Render path are permitted. The key never belongs in the credit JSON. The status command reports key presence only; READY means configuration/confirmation ready, not a provider availability probe or balance measurement.

The credit command refuses an existing file unless --replace is deliberately supplied after checking the dashboard again. --verified-at accepts the actual prior UTC verification time when it differs from command time; expiry is calculated from that time, never silently extended. --hours is 1–24. Refreshing the file resets neither durable audit reservations nor dataset request limits. Editing .env requires restarting a running backend; credit contents are read afresh on provider admission.

Missing, expired, future-dated, oversized, malformed or linked confirmation files make AI unavailable. Existing manual/queue functions and exact-alias local evidence remain available. No automatic refresh, wallet API, paid fallback or startup generation is added. See [Render activation](RENDER.md#sarvam-text-activation) for server-only key and secret-file setup.

## Standing-integration validation

New backend/sarvam-access.js owns bounded no-follow file reads, strict confirmation validation, explicit writes/replacement and safe status. scripts/sarvam-setup.js exposes the operator commands; config.js loads the private path independently of browser settings. services/sarvam.js uses that file gate on each admission. render-start.js accepts enabled text with a server key and reports CREDIT_GATED without making any call. The default deployment still requires mock voice.

The updated backend passed a second live run: private report sarvam-smoke-508af7ae-b2dc-4641-9750-ab1cc91c3270.json, two HTTP 200 responses, normal authorization/audit/replay/review assertions passed, owned cleanup confirmed. Question usage **209 tokens**, latency **1,902.688 ms**; brief usage **590 tokens**, latency **2,117.077 ms**. Total **799 reported tokens**; 1/1 test passed in 5,198.060 ms. This supplements the historical first run below, not a general quality benchmark. The live harness was subsequently changed to use its own credit-file path, so future explicit runs cannot overwrite standing activation; no extra provider call was made for that harness-only edit.

Affected checks passed 31/31. Full npm test passed **169 total / 164 passed / five TODOs / zero failures/skips/cancellations**, 45,060.1933 ms, without real provider calls. New tests cover exact file expiry, invalid/future/long/oversized/UTF-8 inputs, replacement refusal, private paths, safe status, Render-enabled admission and real-file-gated HTTP fallback/manual/queue behavior. No frontend integration or memory retuning was performed.

## Live smoke results

Private report: data/reports/sarvam-smoke-80059af4-2bb5-40ee-a86d-f2464d90cae3.json. Start/end: 2026-10-24T18:25:36.676Z / 18:25:40.257Z. The report contains safe metadata, not the API key or generated note text.

| Check | Actual result |
| --- | --- |
| Provider | Two requests, both HTTP 200, model sarvam-105b. No retry. |
| Hindi question | Expected PENICILLIN_ALLERGY topic; local VERIFIED_POSITIVE evidence retained its evt_demo_penicillin citation. |
| Saved-note brief | Proposal remained DRAFT; original/current note and zero structured items stayed unchanged. Findings, assessment/plan, medicines and follow-up sections were null when unsupplied. Provider quote/reference validation passed. No clinical event was appended. |
| Current authorization | Question refused before grant with no provider request; ordinary patient ALLOW then permitted the question. |
| Audit/replay | A durable reservation preceded each real request outside write units. Same-key replay of each task made no additional provider call. |
| Question usage/latency | 189 prompt + 20 completion = **209 tokens**; observed provider-helper latency **517.074 ms**. |
| Brief usage/latency | 213 prompt + 372 completion = **585 tokens**; observed provider-helper latency **2,446.955 ms**. |
| Total | **794 reported tokens**. These are usage values, not a measured credit debit or remaining balance. |

The native live test passed 1/1, duration 4,118.152 ms. Cleanup removed its temporary promotional-credit attestation and disposable database; a separate post-run check confirmed ordinary live mode off, activation file absent and working database absent. The report fingerprints the executed harness version. Post-run harness reporting was tightened to check cleanup before finalizing future reports; no extra live request was made for that reporting edit.

The ordinary npm test run subsequently passed **161 of 166 tests**, with five TODOs and zero failures/skips/cancellations, duration **44,830.165 ms**. It made no real provider calls; the live filename is excluded from its *.test.js glob. Production backend/prompt/schema code did not change in this section. Memory tuning remains closed at the previously accepted local result.

These two examples establish live key/model/structured-output compatibility and the tested application boundaries. They do not establish multilingual accuracy, general factual grounding, clinical validity, hallucination-free behavior, hosted performance, or guaranteed free usage. Provider-helper timings are individual observations, not p95 or the local deterministic-route latency target.

## Explicit rerun only

tests/sarvam-live-smoke.js is an opt-in live test, not part of npm test, install, build or CI. Confirm positive promotional credit before deliberately rerunning it. Never put the API key in command arguments or reports. With the key already in private .env:

```powershell
$env:SARVAM_LIVE_SMOKE='1'
$env:SARVAM_VERIFIED_CREDIT_INR='<actual operator-verified positive INR amount>'
node --max-semi-space-size=1 --env-file-if-exists=.env --test tests/sarvam-live-smoke.js
Remove-Item Env:SARVAM_LIVE_SMOKE
Remove-Item Env:SARVAM_VERIFIED_CREDIT_INR
```

This explicitly creates an exclusive ten-minute operator attestation in its own private disposable directory, runs at most two provider attempts through real authenticated/consented HTTP, writes a private report and removes owned resources. Its configured access path is isolated from standing activation. It never changes .env or enables the normal server. A failed/timeout attempt can still consume provider credit; no automatic retry or repair call is made. Operator confirmation is not a balance API. The normal one-in-flight, three/minute and thirty/dataset reservation controls remain active in its disposable dataset.

## Remaining AI work

1. Run a separately bounded synthetic evaluation for English/Hindi/romanized paraphrases, unsupported/ambiguous questions, missing sections and unsupported added facts. Record topic correctness and source/field retention with explicit sample counts; do not call two smoke examples an accuracy benchmark.
2. Renew the local confirmation only after a new dashboard balance check when it expires; existing configuration is enabled and no automatic expiry renewal is permitted.
3. Apply the prepared Render setup when requested, supplying the private API key and fresh credit secret file, then verify actual hosted behavior. Repository support is implemented; no service/disk/secret was provisioned remotely.
4. After frontend integration, verify topic/mode labels, reviewable proposals, stale/revoked result clearing and user-visible failure/fallback behavior in real browsers.

No paid top-up/plan/fallback is authorized. Use synthetic data only. The user-reported pre-test credit balance does not establish the post-test balance; inspect the dashboard before later live evaluation or activation.
