import { readdir, mkdir, copyFile, lstat, realpath, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { APP_ROOT, isWithin, parsePublicApiBase } from '../backend/config.js';

const pages = ['login', 'patients', 'encounter', 'patient-visit'];
const shared = ['api.js', 'session.js', 'ui.js', 'config.js', 'styles.css'];
const publicAssetExtensions = new Set(['.css', '.png', '.jpg', '.jpeg', '.webp', '.avif',
  '.svg', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.txt']);

async function assertRegularFile(file) {
  const publicRoot = isWithin(path.join(APP_ROOT, 'frontend'), file) ?
    path.join(APP_ROOT, 'frontend') : path.join(APP_ROOT, 'assets');
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || !isWithin(publicRoot, await realpath(file))) {
    throw new Error('Unsafe public input');
  }
  for (let parent = path.dirname(file); isWithin(publicRoot, parent); parent = path.dirname(parent)) {
    if ((await lstat(parent)).isSymbolicLink()) throw new Error('Linked public input');
    if (parent === publicRoot) break;
  }
}

async function copyPublicFile(source, destination) {
  await assertRegularFile(source);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function copyAssets(source, destination) {
  const root = await lstat(source);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Unsafe asset directory');
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) throw new Error('Dotfiles are not public assets');
    const input = path.join(source, entry.name);
    const output = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Linked public assets are not allowed');
    if (entry.isDirectory()) await copyAssets(input, output);
    else {
      if (!publicAssetExtensions.has(path.extname(entry.name).toLowerCase())) {
        throw new Error('Unsupported public asset type');
      }
      await copyPublicFile(input, output);
    }
  }
}

function compileTailwind() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(APP_ROOT, 'node_modules/@tailwindcss/cli/dist/index.mjs'),
      '-i', 'frontend/shared/styles.css', '-o', 'assets/css/tailwind.css', '--minify',
    ], { cwd: APP_ROOT, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Tailwind build failed')));
  });
}

export async function build(env = process.env) {
  // Build neither opens a database nor loads server origins/provider settings.
  const apiBase = parsePublicApiBase(env.PUBLIC_API_BASE_URL);
  const dist = path.join(APP_ROOT, 'dist');
  const frontend = path.join(APP_ROOT, 'frontend');
  // Check output and generated-CSS directories before invoking the compiler.
  for (const directory of ['frontend', 'assets', 'assets/css']) {
    const target = path.join(APP_ROOT, directory);
    // Generated assets directories are absent in a clean clone.
    if (directory !== 'frontend') {
      try { await mkdir(target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const entry = await lstat(target);
    if (!entry.isDirectory() || entry.isSymbolicLink() ||
        !isWithin(APP_ROOT, await realpath(target))) throw new Error('Unsafe public directory');
  }
  try {
    if ((await lstat(dist)).isSymbolicLink() || !isWithin(APP_ROOT, await realpath(dist))) {
      throw new Error('Unsafe build output');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await assertRegularFile(path.join(APP_ROOT, 'assets/css/tailwind.css')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const page of pages) {
    for (const file of ['index.html', `${page}.css`, `${page}.js`]) {
      await assertRegularFile(path.join(frontend, page, file));
    }
  }
  for (const file of shared) await assertRegularFile(path.join(frontend, 'shared', file));
  await compileTailwind();
  // Only the fixed App/dist target may be cleared; never follow a linked output.
  try {
    if ((await lstat(dist)).isSymbolicLink() || !isWithin(APP_ROOT, await realpath(dist))) {
      throw new Error('Unsafe build output');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist);
  for (const page of pages) {
    for (const file of ['index.html', `${page}.css`, `${page}.js`]) {
      await copyPublicFile(path.join(frontend, page, file), path.join(dist, page, file));
    }
  }
  for (const file of shared) {
    if (file === 'styles.css') continue; // Tailwind input is not deployment output.
    await copyPublicFile(path.join(frontend, 'shared', file), path.join(dist, 'shared', file));
  }
  await writeFile(path.join(dist, 'shared/config.js'),
    `// Public API base only.\nexport const API_BASE_URL = ${JSON.stringify(apiBase)};\n`, 'utf8');
  await copyAssets(path.join(APP_ROOT, 'assets'), path.join(dist, 'assets'));
  if ((await stat(path.join(dist, 'assets/css/tailwind.css'))).size === 0) {
    throw new Error('Compiled CSS is empty');
  }
  return Object.freeze({ pages: pages.length, output: 'dist' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await build())); }
  catch (error) {
    console.error(error.code === 'INVALID_CONFIGURATION' ? error.message : 'Public build failed.');
    process.exitCode = 1;
  }
}
