# VaultMed / CharakVault

A provider-first clinical copilot and hospital OPD workflow prototype for HackCache '26, Problem 2: government-hospital queues and accessible navigation. Working names; final naming is deferred.

**Current state:** this repository contains the earlier backend prototype and service tests. The revised three-page app and hospital-edge architecture are implementation targets, not completed features. Use fictional fixtures and run locally; current routes do not provide the authentication and disclosure controls required for real patient data.

## Run locally

Use **Python 3.12** and Git. Clone this app repository directly; the planning workspace is not required.

```powershell
git clone https://github.com/clastro2024/Hackcache-Hackathon-App.git
Set-Location Hackcache-Hackathon-App
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Open [the local entry point](http://127.0.0.1:8000/) or [interactive API docs](http://127.0.0.1:8000/docs). Stop with Ctrl+C. No API key, database service or patient account setup is needed for this legacy snapshot.

On macOS/Linux, create the environment with `python3.12 -m venv .venv` and replace `.\.venv\Scripts\python.exe` with `.venv/bin/python`. The commands use the environment's Python directly, so PowerShell activation is optional.

For runtime dependencies only, install `-r requirements.txt`. Direct and transitive dependency versions are pinned; the development file adds pytest and the HTTP test client.

## What is here

| Capability | Current snapshot |
| --- | --- |
| Clinical event storage and history projection | Synthetic, in-memory events with hash fields and a projection service; no durable database or complete canonical-chain verification. |
| Source-linked history queries and evidence states | Bounded legacy matching over sample records; not general clinical NLP or proof of safety/completeness. |
| Allow / Deny / Ask Why | Earlier per-question consent service. Request expiry and access enforcement are incomplete; it is not the target 900-second encounter policy. |
| Registry and clinical checks | Seeded registry mock and limited advisory rules; no live NMC verification or clinical validation. |
| Consultation capture | Fixed simulated transcript/extraction; the legacy scribe route directly appends an event. Reviewed draft/commit flow remains to build. |
| Audit and FHIR-like output | In-memory audit and illustrative output; legal/certification wording in legacy responses is not an established guarantee. |
| Queue, navigation and three-page UI | Planned. The old workspace preview is not packaged or required here. |

See [features, architecture and known gaps](docs/STATUS.md) before assessing the prototype. Some legacy comments/response labels overstate guarantees. Hardcoded telemetry values are not benchmarks; a passing test does not establish authentication, clinical safety, compliance or production readiness.

## Test

From this repository's root:

```powershell
.\.venv\Scripts\python.exe -m pytest tests/ -q
.\.venv\Scripts\python.exe -m pip check
```

The GitHub Actions workflow runs the service suite and API entry-point checks on Python 3.12 for Windows and Linux. Remote workflow results must be checked in the repository's Actions tab; committing the workflow alone does not establish that it passed.

## Structure

```text
backend/              FastAPI routes, models and legacy services
defense/              Supporting utilities; not all are wired into routes
tests/                Existing service-level tests
docs/STATUS.md        Current capabilities and intended product scope
CONTRIBUTING.md       Setup, daily collaboration and maintenance
requirements*.txt     Runtime/development dependency entry points
constraints.txt       Tested dependency pins
.github/workflows/    Automated checks
```

## Repository ownership

This is the independent app repository, with fresh history from its setup. Public app code, tests, dependency files and app documentation belong here. Planning notes, design explorations and the larger team workspace stay in their own repository. No subtree synchronization or submodule initialization is required.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the full operational guide and [SECURITY.md](SECURITY.md) for current exposure limits. A project license has not yet been selected.
