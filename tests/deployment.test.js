import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile,unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { deploymentCheck,initializeDeployment,runDeployment,deploymentMaintenance } from '../scripts/render-start.js';
import { loadServerSettings,APP_ROOT } from '../backend/config.js';
import { fixture } from './helpers.js';
import { startServer } from '../backend/server.js';

const origin='https://vaultmed.example.test';
const envFor=db=>({HOST:'0.0.0.0',PORT:'10000',FRONTEND_ORIGIN:origin,API_ORIGIN:origin,
  VAULTMED_DB_PATH:db,PUBLIC_API_BASE_URL:'/api/v1',WEB_CONCURRENCY:'1',USE_MOCK_ASR:'true',SARVAM_ENABLED:'false'});

test('R deployment admission: same-origin HTTPS, one worker, private disk, mock voice and gated text AI',async()=>{
  const file=`data/runtime/deploy-check-${randomUUID()}.sqlite3`,env=envFor(file);
  assert.equal((await runDeployment(['--check'],env)).configuration.status,'CONFIGURATION_VALID');
  assert.equal(existsSync(path.join(APP_ROOT,file)),false);
  for(const [patch,code] of [[{FRONTEND_ORIGIN:'https://other.example.test'},'DEPLOYMENT_SAME_ORIGIN_REQUIRED'],
    [{PUBLIC_API_BASE_URL:'https://other.example.test/api/v1'},'DEPLOYMENT_SAME_ORIGIN_REQUIRED'],
    [{WEB_CONCURRENCY:'2'},'DEPLOYMENT_SINGLE_PROCESS_REQUIRED'],[{SARVAM_ENABLED:'true'},'DEPLOYMENT_AI_KEY_REQUIRED'],
    [{USE_MOCK_ASR:'false'},'DEPLOYMENT_MOCK_VOICE_REQUIRED'],[{VAULTMED_DB_PATH:'data/backups/not-runtime.sqlite3'},'DEPLOYMENT_DISK_PATH_REQUIRED']]) {
    const changed={...env,...patch};assert.throws(()=>deploymentCheck(loadServerSettings(changed),changed),{code});
  }
  const live={...env,SARVAM_ENABLED:'true',SARVAM_API_KEY:'private-stub-key',SARVAM_ACCESS_FILE:'/etc/secrets/sarvam-free-access.json'};
  assert.equal((await runDeployment(['--check'],live)).configuration.provider_calls,'CREDIT_GATED');
  assert.equal(existsSync(path.join(APP_ROOT,file)),false);
  await assert.rejects(()=>runDeployment(['--auto-seed'],env),{code:'INVALID_COMMAND_OPTION'});
});

test('R deployment startup: missing storage is refused without secret lookup or database creation',async()=>{
  const file=`data/runtime/deploy-missing-${randomUUID()}.sqlite3`;
  await assert.rejects(()=>runDeployment([],envFor(file)),{code:'FILE_NOT_FOUND'});
  assert.equal(existsSync(path.join(APP_ROOT,file)),false);
});

test('R/D deployment lifecycle: explicit private init, HTTPS-cookie settings, ordinary reopen and no repeated initialization',async t=>{
  const f=await fixture(t),file=path.join(f.directory,'deployment.sqlite3'),secret=path.join(f.directory,'private-passwords.json');
  const env=envFor(file),settings=loadServerSettings(env);f.store.close();
  await writeFile(secret,JSON.stringify(f.passwords),{mode:0o600});
  await initializeDeployment(settings,secret);
  let runtime=await startServer({...settings,port:0});t.after(()=>runtime.close());
  const base=`http://127.0.0.1:${runtime.server.address().port}`;
  const response=await fetch(`${base}/api/v1/auth/login`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Idempotency-Key':randomUUID()},
    body:JSON.stringify({username:'doctor12',password:f.passwords.doctor12})});
  assert.equal(response.status,200);assert.match(response.headers.get('Set-Cookie'),/; Secure/u);
  assert.match(response.headers.get('Set-Cookie'),/; HttpOnly/u);assert.match(response.headers.get('Set-Cookie'),/SameSite=Strict/iu);
  const login=await response.json(),dataset=runtime.app.locals.store.verification.dataset_id;
  assert.equal(runtime.app.get('trust proxy'),false);await runtime.close();
  await unlink(secret);await assert.rejects(()=>initializeDeployment(settings,secret),{code:'DEPLOYMENT_DATABASE_ALREADY_EXISTS'});
  runtime=await startServer({...settings,port:0});
  assert.equal(runtime.app.locals.store.verification.dataset_id,dataset);
  assert.equal(runtime.app.locals.store.db.prepare('SELECT expires_at FROM sessions').get().expires_at,Date.parse(login.expires_at));
  assert.equal((await fetch(`http://127.0.0.1:${runtime.server.address().port}/api/v1/health/ready`)).status,200);
  await runtime.close();
});

test('R deployment initialization: oversized and malformed private inputs never create storage',async t=>{
  const f=await fixture(t),file=path.join(f.directory,'new.sqlite3'),secret=path.join(f.directory,'private-passwords.json');
  const settings=loadServerSettings(envFor(file));
  for(const contents of ['x'.repeat(8193),'{}','{"bad":true,"bad":false}']){
    await writeFile(secret,contents,{mode:0o600});await assert.rejects(()=>initializeDeployment(settings,secret));assert.equal(existsSync(file),false);
  }
});
test('R10 deployment drain: actual 25-second forced close leaves time within the platform shutdown limit',{timeout:40000},async t=>{
  const f=await fixture(t);f.store.close();const runtime=await startServer({...loadServerSettings(envFor(f.file)),port:0},{shutdownGraceMs:25000});
  t.after(()=>runtime.close());
  const held=http.request({host:'127.0.0.1',port:runtime.server.address().port,path:'/api/v1/auth/login',method:'POST',headers:{
    Origin:origin,'Content-Type':'application/json','X-Idempotency-Key':randomUUID(),'Content-Length':'100'}},response=>response.resume());
  held.on('error',()=>{});held.flushHeaders();held.write('{');await new Promise(resolve=>runtime.server.once('request',resolve));
  const began=performance.now();await runtime.close();const elapsed=performance.now()-began;held.destroy();
  assert.equal(runtime.app.locals.forceDrainCount,1);assert.ok(elapsed>=24500 && elapsed<29000,`drain ${elapsed}`);
  assert.equal(runtime.app.locals.store.db.open,false);
});
test('R/D deployment maintenance: stopped runtime verify/backup/restore, live-owner refusal and no destructive shortcut',async t=>{
  const f=await fixture(t),env=envFor(f.file),backup=path.join(f.directory,'checkpoint.sqlite3'),restored=path.join(f.directory,'restored.sqlite3');
  await assert.rejects(()=>deploymentMaintenance(['verify'],env),{code:'MAINTENANCE_LOCKED'});f.store.close();
  const verified=await deploymentMaintenance(['verify'],env);assert.equal(verified.status,'VERIFIED');
  await assert.rejects(()=>deploymentMaintenance(['verify','--db',backup],env),{code:'DEPLOYMENT_DATABASE_TARGET_MISMATCH'});
  assert.equal((await deploymentMaintenance(['backup','--out',backup],env)).status,'BACKUP_VERIFIED');
  await assert.rejects(()=>deploymentMaintenance(['restore','--backup',backup,'--new-db',restored],env),{code:'DEPLOYMENT_RESTORE_TARGET_MISMATCH'});
  assert.equal(existsSync(restored),false);
  const recovered=await deploymentMaintenance(['restore','--backup',backup,'--new-db',restored],{...env,VAULTMED_DB_PATH:restored});
  assert.equal(recovered.status,'RESTORED');assert.notEqual(recovered.dataset_id,verified.dataset_id);
  assert.equal(existsSync(f.file),true);await assert.rejects(()=>deploymentMaintenance(['reset'],env),{code:'INVALID_COMMAND_OPTION'});
});
