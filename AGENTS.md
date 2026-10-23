# App repository instructions

This is the independent VaultMed / CharakVault app repository. Read README.md, docs/STATUS.md and CONTRIBUTING.md first. Preserve unrelated work.

- Current code is an earlier in-memory backend prototype; distinguish it from the intended three-page app and 900-second encounter-access model.
- Keep Python/FastAPI, the planned SQLite/SQLAlchemy persistence and vanilla frontend. Avoid extra services/frameworks for the two-person, 48-hour scope.
- Use fictional data. Never treat a UI role selector, mock registry ID or public QR as authentication. Enforce authorization on the server before clinical disclosure.
- Preserve positive, scoped documented-negative and not-recorded evidence distinctions; missing records never prove clinical absence or safety.
- Clinical corrections append history. Require clinician review before final clinical commit; optional clinical checks remain non-blocking.
- Label simulations and unverified claims. Do not invent integration, compliance, clinical safety, legal immunity or performance evidence.
- Run `python -m pytest tests/ -q` from this repository root using its virtual environment; report actual results and blockers.
- Commit app changes here. The surrounding planning repository ignores this clone. Follow its instructions too when present, but keep public app docs self-contained.
