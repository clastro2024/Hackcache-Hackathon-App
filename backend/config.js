import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { z } from 'zod';

export const APP_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const PASSWORD_OPTIONS = Object.freeze({ memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const SARVAM_RENDER_ACCESS_FILE='/etc/secrets/sarvam-free-access.json';
export function resolveSarvamAccessFile(value='data/runtime/sarvam-free-access.json') {
  if(value===SARVAM_RENDER_ACCESS_FILE)return value;
  if(typeof value!=='string'||!value.trim()||/[?#\x00-\x1f]/u.test(value)||value.startsWith('//')||value.startsWith('\\\\')||value.slice(2).includes(':'))
    throw new ConfigurationError('SARVAM_ACCESS_FILE');
  const file=path.resolve(APP_ROOT,value);
  if(!['data/runtime','data/test-runs'].some(directory=>file!==path.join(APP_ROOT,directory)&&isWithin(path.join(APP_ROOT,directory),file)))
    throw new ConfigurationError('SARVAM_ACCESS_FILE');
  return file;
}

export class ConfigurationError extends Error {
  constructor(field) {
    super(`Invalid configuration: ${field}`);
    this.name = 'ConfigurationError';
    this.code = 'INVALID_CONFIGURATION';
    this.field = field;
  }
}

function setting(value, field) {
  if (typeof value !== 'string') throw new ConfigurationError(field);
  return value.trim();
}

function origin(value, field) {
  const text = setting(value, field);
  let url;
  try { url = new URL(text); } catch { throw new ConfigurationError(field); }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== text ||
      url.username || url.password || url.search || url.hash) {
    throw new ConfigurationError(field);
  }
  return text;
}

export function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) &&
    relative !== '..' && !path.isAbsolute(relative));
}

export function resolveDatabasePath(value = 'data/runtime/vaultmed.sqlite3') {
  const text = setting(value, 'VAULTMED_DB_PATH');
  // No URI, network share, alternate data stream or query-string path.
  if (!text || text.startsWith('\\\\') || text.startsWith('//') ||
      /[?#\x00-\x1f]/u.test(text) || text.slice(2).includes(':')) {
    throw new ConfigurationError('VAULTMED_DB_PATH');
  }
  const resolved = path.resolve(APP_ROOT, text);
  if (!isWithin(path.join(APP_ROOT, 'data'), resolved) ||
      resolved === path.join(APP_ROOT, 'data')) {
    throw new ConfigurationError('VAULTMED_DB_PATH');
  }
  return resolved;
}

function optionalBoolean(value, defaultValue) {
  if (value === undefined) return Object.freeze({ value: defaultValue, valid: true });
  if (typeof value !== 'string' || !/^(true|false)$/iu.test(value.trim())) {
    return Object.freeze({ value: false, valid: false });
  }
  return Object.freeze({ value: value.trim().toLowerCase() === 'true', valid: true });
}

export function parsePublicApiBase(value = '/api/v1') {
  const text = setting(value, 'PUBLIC_API_BASE_URL');
  if (!text || /[\\\s\x00-\x1f?#]/u.test(text) || /%/u.test(text) ||
      text.split('/').some(part => part === '.' || part === '..')) {
    throw new ConfigurationError('PUBLIC_API_BASE_URL');
  }
  if (text.startsWith('/') && !text.startsWith('//')) return text.replace(/\/$/u, '') || '/';
  let url;
  try { url = new URL(text); } catch { throw new ConfigurationError('PUBLIC_API_BASE_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.origin === 'null') {
    throw new ConfigurationError('PUBLIC_API_BASE_URL');
  }
  if (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
    throw new ConfigurationError('PUBLIC_API_BASE_URL');
  }
  return url.href.replace(/\/$/u, '');
}

export function loadSarvamSettings(env=process.env) {
  const ai=optionalBoolean(env.SARVAM_ENABLED,false);
  const key=typeof env.SARVAM_API_KEY==='string'?env.SARVAM_API_KEY.trim():'';
  return Object.freeze({requested:ai.value,valid:ai.valid,apiKey:key,accessFile:resolveSarvamAccessFile(env.SARVAM_ACCESS_FILE),
    configurationAvailable:ai.valid&&ai.value&&key.length>0});
}

export function loadStorageSettings(env = process.env) {
  return Object.freeze({ appRoot: APP_ROOT, dbPath: resolveDatabasePath(env.VAULTMED_DB_PATH) });
}

export function loadServerSettings(env = process.env) {
  const portText = setting(env.PORT ?? '3000', 'PORT');
  const port = /^\d+$/u.test(portText) ? Number(portText) : NaN;
  if (!z.number().int().min(1).max(65535).safeParse(port).success) {
    throw new ConfigurationError('PORT');
  }
  const host = setting(env.HOST ?? '127.0.0.1', 'HOST');
  if (!isIP(host)) throw new ConfigurationError('HOST');
  const frontendOrigin = origin(env.FRONTEND_ORIGIN, 'FRONTEND_ORIGIN');
  const apiOrigin = origin(env.API_ORIGIN, 'API_ORIGIN');
  const loopback = ['127.0.0.1', '::1'].includes(host);
  for (const value of [frontendOrigin, apiOrigin]) {
    const url = new URL(value);
    if (url.protocol === 'http:' && (!loopback ||
        !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) {
      throw new ConfigurationError('TRANSPORT');
    }
  }
  const mock = optionalBoolean(env.USE_MOCK_ASR, true);
  return Object.freeze({
    ...loadStorageSettings(env), port, host, frontendOrigin, apiOrigin,
    loopbackHttp: new URL(apiOrigin).protocol === 'http:',
    mockAsr: Object.freeze({ enabled: mock.value, valid: mock.valid }),
    sarvam: loadSarvamSettings(env),
  });
}
