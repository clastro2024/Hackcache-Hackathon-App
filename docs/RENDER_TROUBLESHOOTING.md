# Render initialization errors

## MAINTENANCE_LOCKED after a redeploy

The older PID-only file lease could mistake a reused PID in a replacement container for the previous database owner. Removing the bootstrap password file does not cause this error. Current Render leases are scoped to the platform's `RENDER_INSTANCE_ID`, and Linux process start/boot/namespace identity distinguishes a reused PID within that scope. Live or unknown same-instance owners remain refused; no process is killed by lease recovery.

This cross-instance scope relies on Render's documented guarantee that only one instance can access a persistent disk and that the previous disk-backed instance stops before replacement. Historical lease files are left intact and are not database files. Local/non-Render lease paths remain unchanged. Do not set/spoof `RENDER_INSTANCE_ID` yourself or use this scheme for multiple containers sharing a filesystem on another platform.

Redeploy the fixed commit using `npm run deploy:start`, keeping the existing database path and disk. Do not initialize again, recreate the disk, or delete SQLite/WAL/SHM files. Platform behavior still needs confirmation on the hosted service. [Disk lifecycle](https://render.com/docs/disks#disk-limitations-and-considerations), [instance identity](https://render.com/docs/environment-variables#render_instance_id).

## Bootstrap input errors

Build success followed by `INVALID_PRIVATE_INPUT` in an older deployment means the bootstrap reader refused the secret file or its JSON. It does not identify the cause. `.env not found` is harmless when Render supplies environment variables.

The current reader supports regular/projected files at the fixed Render paths for `vellum-passwords.json`, the legacy `vaultmed-passwords.json`, and `sarvam-free-access.json`. Ordinary local linked inputs remain refused. Reads retain byte bounds and descriptor/file-identity checks; file contents are never included in diagnostics. A mounted link is a possible cause of the older error, not a confirmed property of a particular failed deployment.

New bootstrap errors identify the action needed:

| Error | Check privately in Render |
| --- | --- |
| `DEPLOYMENT_PASSWORD_MISSING` | Add the password secret file under Environment → Secret Files using one of the supported filenames. |
| `DEPLOYMENT_PASSWORD_NOT_REGULAR` / `UNREADABLE` / `CHANGED` | Inspect the secret-file mount/permissions and retry the deployment after fixing it. |
| `DEPLOYMENT_PASSWORD_TOO_LARGE` | The complete JSON must be at most 8 KiB. |
| `DEPLOYMENT_PASSWORD_JSON_INVALID` / `UTF8_INVALID` | Use plain UTF-8 JSON with no Markdown fences, duplicate keys or trailing commas. |
| `DEPLOYMENT_PASSWORD_VALUES_INVALID` | Supply exactly staff, doctor12, doctor18, patient-a, patient-b, patient-c and patient-d; each value is a private 12–128-character password. |
| `DEPLOYMENT_DATABASE_ALREADY_EXISTS` | Initialization already created a file. Use normal startup; do not delete or reset the database to retry initialization. |

Keep the same configured database path when retrying. Once initialization succeeds, switch from `npm run deploy:initialize` to `npm run deploy:start`, retaining the same origin environment assignments, and remove the bootstrap password secret. Sarvam's credit secret is separate and must remain if used. Never share the password JSON, API key or file contents in chat or logs.
