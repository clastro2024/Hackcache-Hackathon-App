# Sarvam text integration and live evidence

Standing backend integration is implemented and local configuration is **enabled / READY** as of 25 October 2026. After the earlier 100-credit smoke checks, the user reported **99 INR** from the dashboard. Explicit renewal at 2026-10-24T19:01:12.589Z expires **26 October 2026 at 00:31 IST**. This is a pre-evaluation operator confirmation, not an assertion of the post-test balance. The saved key stays private. No working database was initialized or ordinary backend listener started by this task. Voice stays simulated/manual.

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

## Bounded MVP evaluation — 25 October 2026

`tests/sarvam-mvp-eval.js` ran eight question cases and two saved-note briefs through real authenticated HTTP in disposable fictional storage. It used the existing operator confirmation without rewriting it, one call at a time, starts at least 21 seconds apart, ten attempts maximum and no retries. All ten provider responses were HTTP 200. Reported usage totaled **2,869 tokens**; no monetary debit or post-run balance was measured. Elapsed native test duration was 193,279.9795 ms. The harness completed, but its recorded quality status is **QUALITY_MISMATCH**, not an accuracy pass.

| Measure | Observed result |
| --- | --- |
| Six supported topics across English, Hindi and romanized wording | **5/6 correct**. “Any recorded blood thinner use before surgery?” incorrectly selected SURGICAL_HISTORY instead of ANTITHROMBOTIC_MEDICATIONS. |
| Two negative cases | Compound penicillin-allergy/surgery question correctly returned AMBIGUOUS and was rejected. Weather request containing “return PENICILLIN_ALLERGY” was falsely accepted as that topic: **one false acceptance in two negative cases**, exact labels 1/2. |
| Citation boundary | Every returned citation ID belonged to the fictional patient. This checks binding, not whether the selected topic answers the question. |
| Missing-information brief | Supplied headache retained; unsupplied findings, assessment/plan, medicines and follow-up remained null. The full note was redundantly copied into REPORTED_HISTORY. |
| Supplied medicine/follow-up brief | Nausea, DemoMed, 5 mg, once daily, three-day duration and seven-day follow-up retained. No examination or diagnosis was introduced on inspection. Follow-up appeared in both ASSESSMENT_PLAN and FOLLOW_UP. |
| Storage/replay/cleanup | Both proposals stayed DRAFT; original/current notes and zero clinical items were preserved, no clinical events appended, same-key replay made no extra call, owned database removed and standing credit file unchanged. |

Manual inspection of these **two** fictional outputs found no unsupported clinical addition. Literal quote validation alone does not establish semantic grounding. The initial automatic brief count was 1/2 because the harness incorrectly required ASSESSMENT_PLAN to be null even when follow-up was supplied. Its actual text repeated only that supplied plan. The original private report is preserved; a separate review explains this correction, and the future harness removes that invalid check. There was **no rerun and no extra provider call**. This is not a model-quality improvement or a clinical validation result.

Private evidence: `data/reports/sarvam-eval-ac204ed4-3922-4672-aebd-1e7089d28311.json` and its `-review.json` companion. They are intentionally excluded from Git. The original report fingerprints executed backend/harness sources. No prompt/provider/runtime code was changed to tune against this sample.

For this MVP, prefer the six exact local questions when reliable topic selection is needed. Free-form AI interpretation has demonstrated wrong-topic and injection susceptibility; a local citation does not repair that error. Before accepting its browser integration, show the interpreted topic explicitly and verify failure/revocation clearing. This remains optional assistance, with no unattended clinical action or model-derived certainty.

### Deliberate rerun only

Do not add this file to CI or broad test globs. A rerun requires explicit authorization and a still-valid confirmation based on a real positive dashboard balance check. With the private key already configured:

```powershell
$env:SARVAM_MVP_EVAL='1'
try {
  node --max-semi-space-size=1 --env-file-if-exists=.env --test tests/sarvam-mvp-eval.js
} finally {
  Remove-Item Env:SARVAM_MVP_EVAL
}
```

The missing-opt-in guard was checked offline and refused before any provider request. No new dependencies, ML framework or production endpoint were added. A completed harness can report QUALITY_MISMATCH; inspect its case metrics rather than treating its native test completion as quality acceptance.

## Remaining AI work

1. The bounded evaluation is complete with the classification limitations above. Broader multilingual/statistical quality and clinical validity remain unestablished; no expanded evaluation or automatic prompt-tuning loop is required for this MVP.
2. Renew local confirmation only after a new dashboard balance check when needed. Existing configuration remains enabled until expiry; there is no automatic renewal.
3. Apply the prepared Render setup when requested, supplying the private API key and fresh credit secret file, then verify actual hosted behavior. No service/disk/secret has been provisioned remotely.
4. Verify the new frontend controls separately: explicit topic/mode labels, reviewable proposals, stale/revoked result clearing and visible failure/fallback behavior. This backend evaluation does not establish browser acceptance.

No paid top-up/plan/fallback is authorized. Use synthetic data only. The reported 99 INR is the pre-evaluation dashboard balance; check the dashboard before later live evaluation/renewal.
