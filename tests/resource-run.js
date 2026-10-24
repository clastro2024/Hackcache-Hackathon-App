import path from 'node:path';
import { pathToFileURL } from 'node:url';

// NOT_IMPLEMENTED: later owned-server child, private RSS IPC and actual HTTP timing.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.error('RESOURCE_RUN_NOT_IMPLEMENTED: no server started; performance remains unmeasured.');
  process.exitCode = 1;
}
