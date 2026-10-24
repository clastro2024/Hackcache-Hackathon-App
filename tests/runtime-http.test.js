import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { copyFile, writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers.js';
import { APP_ROOT, loadServerSettings } from '../backend/config.js';
import { createApp } from '../backend/app.js';
import { startServer } from '../backend/server.js';
import { openDatabase } from '../backend/db.js';
import { verifyChains } from '../backend/services/vault.js';
import { putReceipt, fingerprint } from '../backend/services/audit.js';

const origin='http://127.0.0.1:3000';
const settingsFor=(f,port=3000)=>loadServerSettings({FRONTEND_ORIGIN:origin,API_ORIGIN:origin,VAULTMED_DB_PATH:f.file,PORT:String(port)});
test('R01/R04 startup scope: existing verified map required; optional ASR and seed absence do not break manual readiness',async t=>{
  const f=await fixture(t);f.store.close();const directory=path.join(f.directory,'runtime-fixtures');await mkdir(directory);
  await copyFile(path.join(APP_ROOT,'data/fixtures/facility_map.json'),path.join(directory,'facility_map.json'));
  await writeFile(path.join(directory,'mock_asr_outputs.json'),'invalid optional fixture');
  const app=await createApp(settingsFor(f),{fixtureDirectory:directory});assert.equal(app.locals.fixtures.mock.available,false);
  assert.equal(app.locals.fixtures.map.map_version,'opd-map-v1');app.locals.close();
  await writeFile(path.join(directory,'facility_map.json'),'{}');
  await assert.rejects(()=>createApp(settingsFor(f),{fixtureDirectory:directory}),{code:'INVALID_FIXTURE'});
  // Failure released/no lease was acquired; the original database still verifies.
  f.store=openDatabase(f.file,{verifyClinical:verifyChains});
});

test('R01/R05 real listener scope: bounded owner shutdown closes storage, ordinary reopen retains session deadline',async t=>{
  const f=await fixture(t);f.store.close();
  const reservation=http.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const runtime=await startServer(settingsFor(f,port));f.cleanup=()=>runtime.close();f.store=runtime.app.locals.store;
  assert.equal(runtime.server.address().port,port);assert.equal(runtime.app.get('trust proxy'),false);
  const login=await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',
    'X-Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({username:'doctor12',password:f.passwords.doctor12})});
  assert.equal(login.status,200);const body=await login.json();const dataset=runtime.app.locals.store.verification.dataset_id;
  await Promise.all([runtime.close(),runtime.close()]);assert.equal(runtime.server.listening,false);
  assert.equal(runtime.app.locals.store.db.open,false);
  f.store=openDatabase(f.file,{verifyClinical:verifyChains});
  assert.equal(f.store.verification.dataset_id,dataset);const row=f.store.db.prepare('SELECT * FROM sessions').get();
  assert.equal(row.revoked_at,null);assert.equal(row.expires_at,Date.parse(body.expires_at));
  assert.equal(JSON.stringify(row).includes(f.passwords.doctor12),false);
});

test('R01 startup scope: failed listener releases the database lease without reseeding',async t=>{
  const f=await fixture(t);f.store.close();const before=await readFile(f.file);
  const occupied=http.createServer();await new Promise(resolve=>occupied.listen(0,'127.0.0.1',resolve));
  try {await assert.rejects(()=>startServer(settingsFor(f,occupied.address().port)),{code:'EADDRINUSE'});}
  finally {await new Promise(resolve=>occupied.close(resolve));}
  f.store=openDatabase(f.file,{verifyClinical:verifyChains});assert.deepEqual(await readFile(f.file),before);
});

test('R03 startup scope: clock behind the latest persisted receipt is refused and releases ownership',async t=>{
  const f=await fixture(t),future=Date.now()+60000;
  f.store.runUnit(true,()=>putReceipt(f.store,{actor_id:'staff_demo',operation:'TEST_CLOCK',idempotency_key:crypto.randomUUID(),
    request_fingerprint:fingerprint({test:'clock'})},{status:'TEST_CLOCK',changed:false},future));
  f.store.close();
  await assert.rejects(()=>createApp(settingsFor(f)),{code:'TIME_UNTRUSTED'});
  f.store=openDatabase(f.file,{verifyClinical:verifyChains,now:future});
});

test('R10 forced drain: actual 30-second grace closes a held request and releases database ownership',{timeout:45000},async t=>{
  const f=await fixture(t);f.store.close();const runtime=await startServer({...settingsFor(f),port:0});
  f.cleanup=()=>runtime.close();f.store=runtime.app.locals.store;
  const request=http.request({host:'127.0.0.1',port:runtime.server.address().port,path:'/api/v1/auth/login',method:'POST',headers:{
    Origin:origin,'Content-Type':'application/json','X-Idempotency-Key':crypto.randomUUID(),'Content-Length':'100'}},response=>response.resume());
  request.on('error',()=>{});request.flushHeaders();request.write('{');
  await new Promise(resolve=>runtime.server.once('request',resolve));
  const began=performance.now();await runtime.close();const elapsed=performance.now()-began;
  assert.equal(runtime.app.locals.forceDrainCount,1);assert.ok(elapsed>=29500 && elapsed<40000,`drain elapsed ${elapsed}`);
  assert.equal(runtime.app.locals.store.db.open,false);request.destroy();
  f.store=openDatabase(f.file,{verifyClinical:verifyChains});assert.equal(f.store.verification.counts.patients,4);
});
