# Prototype security status

This repository currently contains a legacy, local synthetic-data prototype. It is not suitable for real patient records or public clinical deployment.

Known gaps include unauthenticated clinical/audit routes, caller-supplied identities, incomplete consent expiry/token enforcement, mock registry matching, broad development CORS, in-memory records/audits and a scribe route without the required reviewed-commit gate. Some comments and responses use unsupported legal, safety and tamper-proof labels; those labels are not verified guarantees.

Use fictional fixtures and a loopback server while implementing and testing the replacement controls. Do not commit or upload real patient data, credentials, local databases, backups or raw clinical logs. Ignore rules reduce accidental additions but do not remove a secret already committed.

For a discovered issue, share a minimal synthetic reproduction privately with a repository maintainer or GitHub's private vulnerability reporting if enabled. Do not post credentials or patient information in a public issue. Private reporting has not been configured by this file.

Future changes need server-side actor/scope authorization, meaningful patient choices, durable audit-before-disclosure, reviewed clinical saving and explicit recovery. Tests and code review must establish each control; this document does not implement them.
