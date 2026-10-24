# Memory tuning record and accepted result

On 24 October 2026, the user accepted approximately 89 MB peak RSS and asked to stop further peak-memory tuning. The selected local result is **89,243,648 bytes (89.24 decimal MB)**. This closes the current optimization task; it does not change the historical 85,000,000-byte benchmark comparator or establish a hard memory ceiling. That comparator remains TARGET_MISSED in the original report. Render/Linux memory has not been measured.

## Approaches retained

| Approach | Actual implementation and purpose |
| --- | --- |
| Measure before changing code | tests/resource-server.js samples owned-server RSS every 100 ms; resource-run.js checks PID, freshness and gaps. Opt-in private inspector sampling attributes allocations, including collected objects, without opening an inspector port. Inspector is imported only in profile mode. Full runs load no inspector. |
| Remove key-comparison arrays | services/vault.js compares Unicode code points by index instead of spreading both keys and mapping them into temporary arrays on every sort comparison. Prefix and supplementary-character ordering retain v1 compatibility. |
| Reduce parser scratch allocations | Reuse the number regex, scan whitespace numerically, and handle true/false/null directly. Detect decoded duplicate keys through Object.hasOwn on the already-built null-prototype object instead of allocating a separate Set. Byte/depth/node/number bounds remain. |
| Reduce canonical recursion allocations | Carry the path as a string rather than copied arrays and emit tokens through one writer instead of nested map/join arrays. Preserve the exact capture.confidence float rule, Unicode ordering and existing v1 bytes. |
| Compare canonical tokens directly | canonicalMatches uses the same writer as canonicalJSON and compares each emitted token with stored text. Full-chain verification avoids assembling a second complete canonical envelope. It still checks the complete text, stored bytes, hash chain, mirrors, provenance and entity threads. |
| Hash incrementally | Feed the same ASCII predecessor/separator and UTF-8 canonical bytes into SHA-256 incrementally rather than concatenating new buffers. Persisted hashes/format do not change. |
| Reuse verified source within one call | verifyPatient optionally returns its fully validated envelopes; clinicalSource uses those instead of another SQL read/parse. Capture, final audit and buffered-delivery gates still independently verify current source. No cross-request clinical-answer or authorization cache. |
| Reuse fixed schemas | auth.js retains room/permission/grant-scope schemas; app.js retains the UUID schema. schemas.js checks characters without spreading strings into arrays. Schema validation still runs against each current value. |
| Reuse SQL plans, not results | auth.js owns eight fixed prepared reads; queue.js owns four. Each invocation executes against current database rows. No cached sessions, permissions, grants or patient records. |
| Avoid repeated queue lookups | A queue snapshot derives waiting patients' current-care offset from its already-read active visit, rather than selecting current care again for each item. Command guards/order rules remain unchanged. |
| Select a smaller V8 nursery | Serving, deployment, tests and resource npm commands use --max-semi-space-size=1. The resource child inherits and reports actual flags. This trades nursery capacity for more GC opportunities; it does not cap RSS/old-space or alter SQLite/Argon2 limits. |

## Experiment rejected

The additional --optimize-for-size V8 option was tested on the same full workload. It measured **95,391,744 bytes (95.39 MB)** peak RSS and active-state/query p95 **21.5658/22.0260 ms**. It supplied no measured benefit over the simpler nursery policy and was never added to serving commands. One shared-host comparison does not prove a causal engine regression.

No forced GC, artificial old-space/RSS cap, clinical-answer cache, reduced fixture, authorization bypass, shorter chain verification, weakened password hashing or relaxed SQLite durability was used to obtain a passing number. No runtime dependency, worker or additional backend process was added.

## Measurement history

Full runs used local Windows x64, Node 24.22.1 and SQLite 3.53.4. IDs below refer to ignored private JSON reports under data/reports; the public setup does not require those files. Earlier source/runtime versions are preserved as historical evidence, not fingerprints of later code.

| Full report suffix | Peak RSS, bytes | Active-state/query p95, ms | Interpretation |
| --- | --- | --- | --- |
| 31025593-c193-4f81-a65e-68f6e78b366a | 213,880,832 | 34.3693 / 29.0262 | Before allocation tuning; RSS missed. |
| 0684c129-ef56-4898-a73f-fd8eeb865085 | 152,682,496 | 68.7542 / 26.9533 | First tuned full run; RSS and active-state latency missed. |
| 6f369c23-a0b3-4dc1-a068-3d398554c9ad | 152,039,424 | 24.1389 / 31.2257 | Repeat before SQL-plan/token/nursery changes; RSS missed. |
| ac32aaef-d868-4618-8e28-c62275315880 | **89,243,648** | **17.7551 / 19.9012** | Selected configuration; user-accepted stopping point. Original 85 MB comparator still missed. |
| 670c487c-bf01-4064-8ebf-b6b2a30e7386 | 95,391,744 | 21.5658 / 22.0260 | Additional size-oriented flag rejected. |

The selected run lasted **314.040 seconds**: ten warmups then 120 measured requests per group, no request errors/timeouts, and 312 successful display polls. Normal login, patient approval, the original 900-second grant, audit/receipts, full source checks and WAL/FULL remained enabled. Starts were paced at least 1,200 ms apart; groups ran sequentially. The fictional fixture had twenty patients/visits, two rooms/current encounters, twenty queried-patient events and twenty-one total events. This is not a ten-concurrent-capture or hospital-capacity benchmark.

Owned-server baseline RSS was 74,235,904 bytes. There were 3,108 samples; maximum server/receipt gaps were 156.020/155.949 ms and final sample age was 146.047 ms. All recorded backend/test/script/package/config hashes matched at final verification; only documentation changes followed. The owned child stopped and its disposable directory was removed. No test/build ran concurrently with the selected workload.

The combined changes reduced measured peak RSS **58.27%** from 213,880,832 bytes and **41.30%** from the earlier tuned 152,039,424 bytes. These are combined-version observations on a shared host, not isolated effect sizes. One-second component observations peaked at heapTotal 27,971,584 and heapUsed 24,927,072 bytes; heapUsed includes uncollected garbage and these observations can miss 100 ms RSS transients. No memory-leak diagnosis or hosted-memory guarantee follows.

Short forty-request profiles also guided the work: peaks 114,835,456 before tuning, 103,788,544 after initial reductions, 100,761,600 after source reuse, and 93,421,568 with SQL-plan/snapshot changes plus the smaller nursery, before token comparison. All profile targets remain UNAVAILABLE. Sampling changes allocation/GC overhead; profiles are not retained-live-memory accounting or substitutes for full runs. [STATUS.md](STATUS.md) retains their report IDs and the earlier contended/interrupted-run qualifications.

## Correctness and stopping decision

Latest functional run: **166 total, 161 passed, zero failures/skips/cancellations, five TODOs**, 43,772.526 ms, using the selected nursery setting. Coverage includes fixed Python-reference v1 vectors, noncanonical equivalent-text rejection, duplicate/escaped-key rejection, tampering, current permissions/revocation, review/commit, races, bounded capture/output, real backup/restore and actual forced drain. Environment/native checks, public build, 42 backend/script/test syntax checks and whitespace checks passed. These are existing results; this documentation update did not rerun them.

Further peak-memory optimization is outside the current task by user choice. Keep the selected implementation and investigate new functional/resource regressions when justified. Hosted Linux memory and the real integrated browser journey remain deployment/integration verification, not a reason to reopen speculative local tuning. See [OPERATIONS.md](OPERATIONS.md#resource-run) for reproduction and [RENDER.md](RENDER.md) for the synthetic-data deployment procedure.
