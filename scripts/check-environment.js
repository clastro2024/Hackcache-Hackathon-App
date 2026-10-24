import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = fileURLToPath(new URL('../', import.meta.url));

function requireCheck(condition, stage) {
  if (!condition) {
    const error = new Error(`Environment check failed: ${stage}`);
    error.code = 'ENVIRONMENT_CHECK_FAILED';
    throw error;
  }
}

function sqliteAtLeast(actual, minimum) {
  const values = actual.split('.').map(Number);
  if (values.length !== 3 || values.some(value => !Number.isInteger(value))) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (values[index] !== minimum[index]) return values[index] > minimum[index];
  }
  return true;
}

export async function checkEnvironment() {
  requireCheck(process.versions.node.split('.')[0] === '24', 'NODE_24_REQUIRED');
  const manifest = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(appRoot, 'package-lock.json'), 'utf8'));
  requireCheck(lock.lockfileVersion === 3, 'LOCKFILE_VERSION');
  const packages = {};
  for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const installed = JSON.parse(await readFile(path.join(appRoot, 'node_modules', name, 'package.json'), 'utf8'));
    requireCheck(version === installed.version && version === lock.packages[`node_modules/${name}`]?.version &&
      version === (lock.packages[''].dependencies?.[name] ?? lock.packages[''].devDependencies?.[name]),
    'LOCKED_DEPENDENCIES');
    packages[name] = installed.version;
  }
  const [{ default: express }, { default: Database }, argon2, cookie,
    { default: helmet }, { z }] = await Promise.all([
    import('express'), import('better-sqlite3'), import('argon2'),
    import('cookie'), import('helmet'), import('zod'),
  ]);
  requireCheck(typeof express() === 'function' && typeof helmet() === 'function', 'HTTP_IMPORTS');
  requireCheck(cookie.parseCookie('probe=ok').probe === 'ok' &&
    cookie.stringifySetCookie({ name: 'probe', value: 'ok', httpOnly: true }).startsWith('probe=ok'),
  'COOKIE_API');
  const schema = z.strictObject({ value: z.number().int() });
  requireCheck(schema.safeParse({ value: 1 }).success &&
    !schema.safeParse({ value: 1, extra: true }).success, 'STRICT_ZOD');

  // Binding/version smoke check only: no application file/schema is created.
  let sqliteVersion;
  const db = new Database(':memory:');
  try {
    sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version;
    requireCheck(sqliteAtLeast(sqliteVersion, [3, 51, 3]), 'SQLITE_3_51_3_REQUIRED');
    requireCheck(db.prepare('SELECT ? AS value').get(17).value === 17, 'SQLITE_BINDING');
  } finally { db.close(); }

  // Disposable random probe, never a provisioned account or printed credential.
  const secret = randomBytes(32).toString('base64url');
  const hash = await argon2.hash(secret, { type: argon2.argon2id });
  requireCheck(await argon2.verify(hash, secret) &&
    !(await argon2.verify(hash, `${secret}-wrong`)), 'ARGON2ID_HASH_VERIFY');
  return Object.freeze({ scope: 'SETUP_ONLY', node: process.versions.node,
    platform: process.platform, architecture: process.arch, packages,
    sqlite: sqliteVersion, database: 'IN_MEMORY_ONLY', argon2: 'HASH_VERIFY_OK',
    application: 'NOT_PROBED' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await checkEnvironment(), null, 2)); }
  catch (error) {
    console.error(error.code === 'ENVIRONMENT_CHECK_FAILED' ? error.message :
      'Environment check failed: DEPENDENCY_OR_NATIVE_BINDING. Run npm ci under Node 24.');
    process.exitCode = 1;
  }
}
