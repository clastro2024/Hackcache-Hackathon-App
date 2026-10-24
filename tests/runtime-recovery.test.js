import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initializeDatabase, verifyDatabase, backupDatabase, restoreDatabase, resetDatabase, loadFixtures } from '../backend/manage.js';
import { openDatabase, privatePath } from '../backend/db.js';
import { appendAudit, putReceipt, fingerprint } from '../backend/services/audit.js';
import { canonicalJSON, verifyChains } from '../backend/services/vault.js';
import { APP_ROOT } from '../backend/config.js';
import { randomUUID } from 'node:crypto';
import { fixture, ownedDirectory, removeOwned, testPasswords } from './helpers.js';

function authorizationRows(store) {
  const now=Date.now();const scopes=canonicalJSON(['triage:read','vault:query','affirmation:run','summary:export']);
  store.runUnit(true,()=>{
    for(const [session,account,secret] of [['session_12','clinician_12','a'],['session_18','clinician_18','b']]) {
      store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,NULL)').run(session,account,secret.repeat(64),'fictional-csrf',now,now+7200000);
    }
    store.db.prepare(`INSERT INTO consent_requests VALUES('request_allowed','encounter_demo_ledger','patient_demo_ledger','clinician_12','session_12',
      'facility_demo','OPD_CONSULTATION',?,'Fictional explanation','ALLOWED',?,?,0,?,'account_patient_1','PHONE',NULL,NULL)`)
      .run(scopes,now,now+300000,now);
    store.db.prepare(`INSERT INTO consent_requests VALUES('request_pending','encounter_demo_negative','patient_demo_negative','clinician_18','session_18',
      'facility_demo','OPD_CONSULTATION',?,'Fictional explanation','REQUESTED',?,?,0,NULL,NULL,NULL,NULL,NULL)`)
      .run(scopes,now,now+300000);
    const audit=appendAudit(store,{actor_id:'account_patient_1',patient_id:'patient_demo_ledger',encounter_id:'encounter_demo_ledger',
      operation:'CONSENT_ALLOW',result:'SUCCESS',recorded_at:now,details:{request_id:'request_allowed',mode:'PATIENT_APPROVED'}});
    store.db.prepare(`INSERT INTO encounter_grants VALUES('grant_test','request_allowed','encounter_demo_ledger','patient_demo_ledger','clinician_12','session_12',
      'facility_demo','OPD_CONSULTATION',?,'PATIENT_APPROVED','ACTIVE',?,?,NULL,NULL,?,0)`).run(scopes,now,now+900000,audit);
  });
}

test('D01/D11 storage scope: existing-file gate, idempotent init and ordinary restart retain state/deadlines',async t=>{
  const f=await fixture(t);authorizationRows(f.store);
  const original=f.store.db.prepare('SELECT * FROM sessions ORDER BY session_id').all();
  assert.ok(f.store.db.prepare('SELECT e.recorded_at,m.created_at FROM clinical_events e CROSS JOIN schema_meta m').all()
    .every(row=>row.recorded_at===row.created_at));
  const dataset=f.store.verification.dataset_id;
  f.store.runUnit(true,()=>f.store.db.prepare('UPDATE schema_meta SET next_token_number=9 WHERE singleton=1').run());
  assert.throws(()=>verifyDatabase(f.file),error=>error.code==='MAINTENANCE_LOCKED');
  f.store.close();
  const initialized=await initializeDatabase(f.file);
  assert.equal(initialized.status,'ALREADY_INITIALIZED');assert.equal(initialized.dataset_id,dataset);
  f.store=openDatabase(f.file,{verifyClinical:verifyChains});
  assert.deepEqual(f.store.db.prepare('SELECT * FROM sessions ORDER BY session_id').all(),original);
  assert.equal(f.store.db.prepare('SELECT next_token_number FROM schema_meta').get().next_token_number,9);
  const missing=path.join(f.directory,'missing.sqlite3');
  assert.throws(()=>verifyDatabase(missing),error=>error.code==='FILE_NOT_FOUND');assert.equal(existsSync(missing),false);
  const empty=path.join(f.directory,'empty.sqlite3');await writeFile(empty,'');
  assert.throws(()=>verifyDatabase(empty));assert.equal((await readFile(empty)).length,0);
});

test('D01/D12 storage scope: unsupported schema and removed guards are refused without reseeding',async t=>{
  const f=await fixture(t);f.store.close();
  const db=new Database(f.file,{fileMustExist:true});db.pragma('user_version=99');db.close();
  await assert.rejects(()=>initializeDatabase(f.file),error=>error.code==='UNSUPPORTED_SCHEMA');
  const altered=new Database(f.file,{fileMustExist:true});altered.pragma('user_version=1');altered.exec('DROP TRIGGER audit_no_delete');altered.close();
  assert.throws(()=>verifyDatabase(f.file),error=>error.code==='SCHEMA_DEFINITION_MISMATCH');
});

test('D10 storage scope: standalone verified backup, changed recovery branch, ended access and preserved source',async t=>{
  const f=await fixture(t);authorizationRows(f.store);
  const originalDeadlines=f.store.db.prepare('SELECT session_id,expires_at FROM sessions ORDER BY session_id').all();
  const originalDataset=f.store.verification.dataset_id;
  const heads=verifyChains(f.store.db);f.store.close();
  const backup=path.join(f.directory,'checkpoint.sqlite3');const restored=path.join(f.directory,'restored.sqlite3');
  const checkpoint=await backupDatabase(f.file,backup);
  assert.equal(checkpoint.status,'BACKUP_VERIFIED');assert.equal(existsSync(`${backup}-wal`),false);
  const artifact=new Database(backup,{readonly:true,fileMustExist:true});assert.equal(artifact.pragma('journal_mode',{simple:true}),'delete');artifact.close();
  f.store=openDatabase(f.file,{verifyClinical:verifyChains});
  f.store.runUnit(true,()=>{
    const now=Date.now();
    f.store.db.prepare('UPDATE sessions SET revoked_at=?').run(now);
    f.store.db.prepare("UPDATE encounter_grants SET state='REVOKED',ended_at=?,end_reason='PATIENT_REVOKED',version=version+1").run(now);
    f.store.db.prepare("UPDATE consent_requests SET state='CANCELLED',end_reason='LOGOUT' WHERE state='REQUESTED'").run();
    f.store.db.prepare('UPDATE rooms SET version=5').run();
    putReceipt(f.store,{actor_id:'staff_demo',operation:'POST /after-backup',idempotency_key:randomUUID(),request_fingerprint:fingerprint({version:5})},
      {status:'OK',changed:true,version:5},now);
  });f.store.close();
  const originalBytes=await readFile(f.file);const backupBytes=await readFile(backup);
  const result=await restoreDatabase(backup,restored);
  assert.notEqual(result.dataset_id,originalDataset);assert.equal(result.requires_queue_reconciliation,true);
  assert.deepEqual(result.clinical_heads,heads);
  assert.deepEqual(await readFile(f.file),originalBytes);assert.deepEqual(await readFile(backup),backupBytes);
  const recovered=openDatabase(restored,{verifyClinical:verifyChains});
  try {
    assert.deepEqual(recovered.db.prepare('SELECT session_id,expires_at FROM sessions ORDER BY session_id').all(),originalDeadlines);
    assert.equal(recovered.db.prepare('SELECT COUNT(*) n FROM sessions WHERE revoked_at IS NULL').get().n,0);
    assert.equal(recovered.db.prepare("SELECT state,end_reason FROM consent_requests WHERE request_id='request_pending'").get().end_reason,'RESTORE');
    assert.deepEqual(recovered.db.prepare('SELECT state,end_reason FROM encounter_grants').get(),{state:'ENDED',end_reason:'RESTORE'});
    assert.equal(recovered.db.prepare('SELECT COUNT(*) n FROM mutation_receipts').get().n,0);
    assert.equal(recovered.db.prepare("SELECT COUNT(*) n FROM rooms WHERE service_state='PAUSED_ON_BREAK'").get().n,2);
    assert.equal(recovered.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE operation='DATASET_RESTORED'").get().n,1);
    assert.equal(JSON.parse(recovered.db.prepare('SELECT restored_from_json FROM schema_meta').get().restored_from_json).source_dataset_id,originalDataset);
  } finally {recovered.close();}
  await assert.rejects(()=>restoreDatabase(backup,restored),error=>error.code==='DESTINATION_EXISTS');
  await assert.rejects(()=>backupDatabase(f.file,backup),error=>error.code==='DESTINATION_EXISTS');
});

test('D10 storage scope: corrupted checksum/manifest never creates a restored destination',async t=>{
  const f=await fixture(t);f.store.close();const backup=path.join(f.directory,'checkpoint.sqlite3');
  await backupDatabase(f.file,backup);
  const manifest=JSON.parse(await readFile(`${backup}.manifest.json`,'utf8'));
  const newFile=path.join(f.directory,'rejected.sqlite3');
  await writeFile(`${backup}.manifest.json`,JSON.stringify({...manifest,backup_sha256:'f'.repeat(64)}));
  await assert.rejects(()=>restoreDatabase(backup,newFile),error=>error.code==='BACKUP_CHECKSUM_MISMATCH');
  assert.equal(existsSync(newFile),false);
  await writeFile(`${backup}.manifest.json`,JSON.stringify({...manifest,counts:{...manifest.counts,patients:99}}));
  await assert.rejects(()=>restoreDatabase(backup,newFile),error=>error.code==='BACKUP_METADATA_MISMATCH');
  assert.equal(existsSync(newFile),false);
});

test('D11 storage scope: reset retains old file and verified backup, creates a separate fictional dataset',async t=>{
  const f=await fixture(t);const oldDataset=f.store.verification.dataset_id;f.store.close();
  const file=path.join(f.directory,'new.sqlite3');const backup=path.join(f.directory,'before-reset.sqlite3');
  const result=await resetDatabase(f.file,file,{passwords:testPasswords,backupOut:backup});
  assert.equal(result.status,'RESET_TO_NEW_DATASET');assert.notEqual(result.dataset_id,oldDataset);
  assert.equal(verifyDatabase(f.file).dataset_id,oldDataset);await access(`${backup}.manifest.json`);
  assert.equal(result.counts.sessions,0);assert.equal(result.counts.encounter_grants,0);
  await assert.rejects(()=>resetDatabase(f.file,file,{passwords:testPasswords,backupOut:backup}),error=>error.code==='DESTINATION_EXISTS');
});

function command(args,{input,cwd=APP_ROOT,env={}}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(APP_ROOT,'backend/manage.js'),...args],{cwd,windowsHide:true,
      env:{...process.env,FRONTEND_ORIGIN:'invalid-irrelevant',API_ORIGIN:'invalid-irrelevant',...env},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(Error('Maintenance child timed out'));},12000);
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('exit',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
    child.stdin.end(input);
  });
}
test('D01/D11 maintenance CLI: private stdin initialization, alternate cwd, verification and safe failures',{timeout:20000},async t=>{
  const dir=await ownedDirectory();t.after(()=>removeOwned(dir));const file=path.join(dir,'cli.sqlite3');
  const initialized=await command(['init','--db',file,'--seed','opd-demo-v1','--passwords-stdin'],{cwd:dir,input:JSON.stringify(testPasswords)});
  assert.equal(initialized.code,0,initialized.stderr);assert.equal(JSON.parse(initialized.stdout).status,'INITIALIZED');
  for(const secret of Object.values(testPasswords)) assert.equal(`${initialized.stdout}${initialized.stderr}`.includes(secret),false);
  const verified=await command(['verify','--db',file],{cwd:dir,env:{VAULTMED_DB_PATH:'../invalid-unused-default'}});
  assert.equal(verified.code,0,verified.stderr);assert.equal(JSON.parse(verified.stdout).status,'VERIFIED');
  const replay=await command(['init','--db',file]);assert.equal(JSON.parse(replay.stdout).status,'ALREADY_INITIALIZED');
  const rejected=await command(['init','--db',path.join(dir,'no-password.sqlite3')]);
  assert.equal(rejected.code,1);assert.equal(JSON.parse(rejected.stderr).error,'PRIVATE_PASSWORD_INPUT_REQUIRED');
  assert.equal(existsSync(path.join(dir,'no-password.sqlite3')),false);
});

test('D01 fixtures: map links, three offline names and no reusable credential/source authority',()=>{
  const {seed,map,mock}=loadFixtures();assert.equal(mock.available,true);assert.equal(mock.registry.fixtures.length,3);
  assert.equal(seed.map_version,map.map_version);assert.equal(seed.accounts.length,7);
  assert.equal(mock.registry.fixtures[1].item_templates.length,0);
  assert.equal(seed.accounts.some(account=>'password' in account || 'password_hash' in account),false);
});
test('D01/ASR01 fixture-loader scope: invalid optional ASR preserves valid core seed/map',async t=>{
  const dir=await ownedDirectory();t.after(()=>removeOwned(dir));
  for(const name of ['seed.json','facility_map.json']) await copyFile(path.join(APP_ROOT,'data/fixtures',name),path.join(dir,name));
  await writeFile(path.join(dir,'mock_asr_outputs.json'),'{"fixtures":[],"fixtures":[]}');
  const fixtures=loadFixtures(dir);assert.equal(fixtures.mock.available,false);assert.equal(fixtures.seed.accounts.length,7);
  assert.equal(fixtures.map.nodes.length>0,true);assert.ok(Object.isFrozen(fixtures.seed.accounts));
  assert.throws(()=>privatePath('data/fixtures/unsafe-database.json'),error=>error.code==='UNSAFE_PRIVATE_PATH');
  assert.throws(()=>privatePath('data/unignored-database.json'),error=>error.code==='UNSAFE_PRIVATE_PATH');
});
test.todo('R/D acceptance remaining: hosted cookies and persistent-volume recovery');
