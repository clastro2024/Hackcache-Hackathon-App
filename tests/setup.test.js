import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ROOT, isWithin, loadServerSettings, loadStorageSettings,
  parsePublicApiBase, resolveDatabasePath } from '../backend/config.js';
import { build } from '../scripts/build.js';

const execute = promisify(execFile);
const safeEnv = { FRONTEND_ORIGIN: 'http://127.0.0.1:3000', API_ORIGIN: 'http://127.0.0.1:3000' };
const sentinel = 'VAULTMED_SETUP_PRIVATE_SENTINEL';

async function scratch(t) {
  const parent = path.join(APP_ROOT, 'data/test-runs');
  await mkdir(parent, { recursive: true });
  assert.ok(!(await lstat(parent)).isSymbolicLink() && isWithin(APP_ROOT, await realpath(parent)));
  const target = await mkdtemp(path.join(parent, 'setup-'));
  t.after(async () => {
    // Only remove this test's resolved child, never a working dataset or linked root.
    assert.ok(isWithin(parent, target) && target !== parent &&
      !(await lstat(target)).isSymbolicLink() && isWithin(parent, await realpath(target)));
    await rm(target, { recursive: true, force: true });
  });
  return target;
}

async function runNode(args, options = {}) {
  try {
    const result = await execute(process.execPath, args, {
      cwd: APP_ROOT, timeout: 15000, maxBuffer: 1024 * 1024,
      env: { ...process.env, SARVAM_API_KEY: sentinel }, ...options,
    });
    return { code: 0, ...result };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function walk(root, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false);
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, child));
    else files.push(child.replaceAll(path.sep, '/'));
  }
  return files;
}

test('settings use private App-relative storage and independent disabled AI/mock flags', () => {
  const settings = loadServerSettings(safeEnv);
  assert.equal(settings.dbPath, path.join(APP_ROOT, 'data/runtime/vaultmed.sqlite3'));
  assert.equal(settings.sarvam.requested, false);
  assert.equal(settings.mockAsr.enabled, true);
  assert.ok(Object.isFrozen(settings) && Object.isFrozen(settings.sarvam));
  const manual = loadServerSettings({ ...safeEnv, USE_MOCK_ASR: 'false' });
  assert.equal(manual.mockAsr.enabled, false);
  assert.equal(manual.sarvam.requested, false);
  assert.equal(manual.sarvam.configurationAvailable, false);
});

test('storage maintenance settings do not require browser origins', () => {
  const settings = loadStorageSettings({ VAULTMED_DB_PATH: 'data/test-runs/example.sqlite3' });
  assert.equal(settings.dbPath, path.join(APP_ROOT, 'data/test-runs/example.sqlite3'));
});

test('invalid core settings fail with safe field-only errors', () => {
  for (const [field, value] of [
    ['PORT', '0'], ['PORT', '1.5'], ['PORT', '65536'], ['PORT', 'bad'],
    ['HOST', 'example.com'], ['FRONTEND_ORIGIN', `https://user:${sentinel}@example.com`],
    ['API_ORIGIN', 'https://example.com/path'], ['API_ORIGIN', 'null'],
  ]) {
    assert.throws(() => loadServerSettings({ ...safeEnv, [field]: value }), error =>
      error.code === 'INVALID_CONFIGURATION' && !error.message.includes(sentinel));
  }
  assert.throws(() => loadServerSettings({ ...safeEnv, HOST: '0.0.0.0' }),
    error => error.field === 'TRANSPORT');
});

test('malformed optional flags report unavailable rather than enabling live work', () => {
  const settings = loadServerSettings({ ...safeEnv, USE_MOCK_ASR: 'invalid',
    SARVAM_ENABLED: 'yes', SARVAM_API_KEY: sentinel });
  assert.deepEqual(settings.mockAsr, { enabled: false, valid: false });
  assert.equal(settings.sarvam.valid, false);
  assert.equal(settings.sarvam.configurationAvailable, false);
});

test('database paths reject escape, URI, network and alternate-stream input', () => {
  for (const value of ['../outside.sqlite3', 'data/../../outside.sqlite3', 'data',
    ':memory:', 'file:data/runtime/example.sqlite3', '//server/share/db',
    '\\\\server\\share\\db', 'data/runtime/db:secret', 'data/runtime/db?mode=ro']) {
    assert.throws(() => resolveDatabasePath(value), error => error.field === 'VAULTMED_DB_PATH');
  }
});

test('public API config permits explicit paths/HTTPS and rejects credential-bearing input', () => {
  assert.equal(parsePublicApiBase('/api/v1/'), '/api/v1');
  assert.equal(parsePublicApiBase('https://api.example.com/api/v1'), 'https://api.example.com/api/v1');
  for (const value of ['//evil.example/api', 'http://api.example.com',
    `https://user:${sentinel}@api.example.com`, '/api/../private', '/api/%2e%2e/private',
    '/api?q=secret', '/api#fragment', 'javascript:alert(1)']) {
    assert.throws(() => parsePublicApiBase(value), error => error.field === 'PUBLIC_API_BASE_URL');
  }
});

test('Node env-file loading preserves existing process environment', async t => {
  const directory = await scratch(t);
  const file = path.join(directory, '.env');
  await writeFile(file, 'VAULTMED_SETUP_PROBE=from-file\n');
  const result = await runNode([`--env-file=${file}`, '-e',
    'process.stdout.write(process.env.VAULTMED_SETUP_PROBE)'], {
    env: { ...process.env, VAULTMED_SETUP_PROBE: 'from-process' },
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'from-process');
});

test('server refuses missing storage and unfinished resource runner refuses action without leaking settings', async t => {
  const runtime = await readdir(path.join(APP_ROOT, 'data/runtime'));
  const directory=await scratch(t);
  for (const [file, args, marker] of [
    ['backend/server.js', [], 'STARTUP_FAILED: FILE_NOT_FOUND'],
    ['tests/resource-run.js', [], 'RESOURCE_RUN_NOT_IMPLEMENTED'],
  ]) {
    const result = await runNode([file, ...args],{env:{...process.env,...safeEnv,SARVAM_API_KEY:sentinel,
      VAULTMED_DB_PATH:path.join(directory,'missing.sqlite3')}});
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes(marker));
    assert.equal(`${result.stdout}${result.stderr}`.includes(sentinel), false);
  }
  assert.deepEqual(await readdir(path.join(APP_ROOT, 'data/runtime')), runtime);
  const help = await runNode(['backend/manage.js', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Stop the backend first/);
});

test('public build includes page/shared modules and CSS, excluding all private inputs', async () => {
  const runtime = await readdir(path.join(APP_ROOT, 'data/runtime'));
  const result = await build({ PUBLIC_API_BASE_URL: '/api/v1', SARVAM_API_KEY: sentinel,
    PORT: 'invalid-server-setting', VAULTMED_DB_PATH: '../invalid-server-path' });
  assert.equal(result.pages, 4);
  const dist = path.join(APP_ROOT, 'dist');
  const files = await walk(dist);
  for (const page of ['login', 'patients', 'encounter', 'patient-visit']) {
    for (const name of ['index.html', `${page}.js`, `${page}.css`]) {
      assert.ok(files.includes(`${page}/${name}`));
    }
  }
  for (const name of ['api', 'session', 'ui', 'config']) assert.ok(files.includes(`shared/${name}.js`));
  assert.ok(files.includes('assets/css/tailwind.css'));
  assert.ok((await readFile(path.join(dist, 'assets/css/tailwind.css'))).length > 0);
  const config = await readFile(path.join(dist, 'shared/config.js'), 'utf8');
  assert.match(config, /export const API_BASE_URL = "\/api\/v1"/);
  for (const file of files) {
    assert.ok(/^(login|patients|encounter|patient-visit|shared|assets)\//u.test(file));
    assert.equal(/(^|\/)(\.env[^/]*|node_modules|backend|data|tests|\.git)(\/|$)/u.test(file), false);
    const content = await readFile(path.join(dist, file));
    assert.equal(content.includes(Buffer.from(sentinel)), false);
    assert.equal(content.includes(Buffer.from('SARVAM_API_KEY')), false);
  }
  assert.deepEqual(await readdir(path.join(APP_ROOT, 'data/runtime')), runtime);
});

test('a linked build-output directory is rejected before clearing its target', async t => {
  const directory = await scratch(t);
  for (const subdirectory of ['scripts', 'backend', 'frontend', 'assets/css', 'preserved']) {
    await mkdir(path.join(directory, subdirectory), { recursive: true });
  }
  await copyFile(path.join(APP_ROOT, 'scripts/build.js'), path.join(directory, 'scripts/build.js'));
  await copyFile(path.join(APP_ROOT, 'backend/config.js'), path.join(directory, 'backend/config.js'));
  await writeFile(path.join(directory, 'preserved/keep.txt'), 'preserved');
  await symlink(path.join(directory, 'preserved'), path.join(directory, 'dist'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const sandbox = await import(pathToFileURL(path.join(directory, 'scripts/build.js')).href);
  await assert.rejects(() => sandbox.build({}), /Unsafe build output/);
  assert.equal(await readFile(path.join(directory, 'preserved/keep.txt'), 'utf8'), 'preserved');
});
