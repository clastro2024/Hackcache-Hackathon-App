import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { schemaStatements, retryUnit, openDatabase } from '../backend/db.js';
import { appendAudit, putReceipt, findReceipt, fingerprint } from '../backend/services/audit.js';
import { appendEvents, verifyChains, parseJSON } from '../backend/services/vault.js';
import { APP_ROOT } from '../backend/config.js';
import { fixture } from './helpers.js';

const audit=()=>({actor_id:'staff_demo',patient_id:null,encounter_id:null,operation:'QUEUE_TEST',result:'SUCCESS',recorded_at:Date.now(),details:{count:1}});
const key=()=>({actor_id:'staff_demo',operation:'POST /test/room',idempotency_key:randomUUID(),
  request_fingerprint:fingerprint({method:'POST',path:'/test/room',body:{expected_version:0}})});
const snapshot=store=>store.runUnit(false,()=>({rooms:store.db.prepare('SELECT * FROM rooms ORDER BY room_id').all(),
  audit:store.db.prepare('SELECT * FROM audit_events').all(),receipts:store.db.prepare('SELECT * FROM mutation_receipts').all()}));

test('D01/D02 storage scope: actual settings, thirteen tables, constraints and mixed-patient references',async t=>{
  const {store}=await fixture(t);
  assert.equal(store.db.pragma('journal_mode',{simple:true}),'wal');
  assert.equal(store.db.pragma('synchronous',{simple:true}),2);
  assert.equal(store.db.pragma('foreign_keys',{simple:true}),1);
  assert.equal(store.db.pragma('busy_timeout',{simple:true}),50);
  assert.equal(Object.keys(store.verification.counts).length,13);
  assert.throws(()=>store.runUnit(true,()=>store.db.prepare("UPDATE visits SET queue_rank=0 WHERE queue_state='WAITING'").run()));
  assert.throws(()=>store.runUnit(true,()=>store.db.prepare("UPDATE visits SET room_id='room_18' WHERE visit_id='visit_demo_1'").run()));
  assert.throws(()=>store.runUnit(true,()=>store.db.prepare("UPDATE encounters SET patient_id='patient_demo_negative' WHERE encounter_id='encounter_demo_ledger'").run()));
  assert.throws(()=>store.runUnit(true,()=>store.db.prepare("UPDATE encounters SET checked_in_at=NULL WHERE encounter_id='encounter_demo_ledger'").run()));
  assert.throws(()=>store.runUnit(true,()=>store.db.prepare("UPDATE encounters SET closure_reason='INVALID' WHERE encounter_id='encounter_demo_ledger'").run()));
});

test('D08 storage scope: business, audit and receipt roll back as one unit on each failure boundary',async t=>{
  const {store}=await fixture(t);const before=snapshot(store);
  for(const boundary of ['before-audit','audit','receipt','after-receipt']) {
    assert.throws(()=>store.runUnit(true,()=>{
      store.db.prepare("UPDATE rooms SET version=version+1 WHERE room_id='room_12'").run();
      if(boundary==='before-audit') throw Error('injected-before-audit');
      appendAudit(store,boundary==='audit'?{...audit(),details:{password:'rejected'}}:audit());
      putReceipt(store,key(),boundary==='receipt'?{status:'OK',changed:true,answer:'rejected'}:{status:'OK',changed:true,version:1},Date.now());
      throw Error('injected-after-receipt');
    }));
    assert.deepEqual(snapshot(store),before);
  }
});

test('D05/D08 storage scope: same intent recovers one committed safe receipt; changed intent conflicts',async t=>{
  const {store}=await fixture(t);const intent=key();
  const command=()=>store.runUnit(true,()=>{
    const receipt=findReceipt(store,intent);if(receipt) return receipt.outcome;
    store.db.prepare("UPDATE rooms SET version=version+1 WHERE room_id='room_12'").run();
    appendAudit(store,audit());return putReceipt(store,intent,{status:'OK',changed:true,version:1},Date.now());
  });
  assert.deepEqual(command(),command());
  assert.equal(store.db.prepare("SELECT version FROM rooms WHERE room_id='room_12'").get().version,1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM mutation_receipts').get().n,1);
  assert.throws(()=>store.runUnit(false,()=>findReceipt(store,{...intent,request_fingerprint:'f'.repeat(64)})),error=>error.code==='IDEMPOTENCY_CONFLICT');
  assert.equal(fingerprint({b:2,a:1}),fingerprint({a:1,b:2}));
});

test('D07 storage scope: UPDATE, DELETE and REPLACE cannot rewrite clinical/audit/receipt history',async t=>{
  const {store}=await fixture(t);store.runUnit(true,()=>putReceipt(store,key(),{status:'OK',changed:true},Date.now()));
  for(const table of ['clinical_events','audit_events','mutation_receipts']) {
    for(const sql of [`DELETE FROM ${table}`,`UPDATE ${table} SET ${table==='clinical_events'?'recorded_at':table==='audit_events'?'recorded_at':'created_at'}=0`,
      `INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`]) assert.throws(()=>store.runUnit(true,()=>store.db.exec(sql)));
  }
});

test('D06/C04 storage scope: single successor, same-thread batch refusal and atomic append rollback',async t=>{
  const {store}=await fixture(t);
  const original=parseJSON(store.db.prepare("SELECT event_json FROM clinical_events WHERE event_id='evt_demo_penicillin'").get().event_json);
  const successor={...original,event_id:'evt_correction_1',sequence:3,supersedes_event_id:original.event_id,change_kind:'CORRECTION',change_reason:'Fictional source correction'};
  store.runUnit(true,()=>appendEvents(store,[successor],{fixtureSeed:true}));
  assert.throws(()=>store.runUnit(true,()=>appendEvents(store,[{...successor,event_id:'evt_competing',sequence:4}],{fixtureSeed:true})));
  const next={...successor,event_id:'evt_correction_2',sequence:4,supersedes_event_id:successor.event_id};
  assert.throws(()=>store.runUnit(true,()=>{appendEvents(store,[next],{fixtureSeed:true});throw Error('injected-batch-failure');}));
  assert.equal(store.db.prepare("SELECT MAX(sequence) n FROM clinical_events WHERE patient_id='patient_demo_ledger'").get().n,3);
  assert.throws(()=>store.runUnit(true,()=>appendEvents(store,[next,{...next,event_id:'evt_same_thread',sequence:5}],{fixtureSeed:true})));
  assert.equal(verifyChains(store.db).find(p=>p.patient_id==='patient_demo_ledger').checked_events,3);
  assert.throws(()=>store.runUnit(true,()=>appendEvents(store,[next])),error=>error.code==='REVIEWED_COMMIT_REQUIRED');
});

test('D09 storage scope: actual SQLite writer lock, three bounded attempts and waits outside transactions',async t=>{
  const {store,file}=await fixture(t);const blocker=new Database(file,{fileMustExist:true});
  const waits=[];let calls=0;
  blocker.exec('BEGIN IMMEDIATE');
  try {
    await assert.rejects(()=>retryUnit(store,true,()=>{calls+=1;},{random:()=>0,
      sleep:async ms=>{assert.equal(store.db.inTransaction,false);waits.push(ms);}}),error=>error.code==='EDGE_BUSY');
  } finally {blocker.exec('ROLLBACK');blocker.close();}
  assert.equal(calls,0);assert.equal(waits.length,2);
  assert.equal(await retryUnit(store,true,()=>42),42);
  let failures=0;
  await assert.rejects(()=>retryUnit(store,true,()=>{failures+=1;throw Object.assign(Error('injected disk failure'),{code:'SQLITE_FULL'});}));
  assert.equal(failures,1);
});

test('D09 storage scope: nested/async units rejected; returned Promise rolls back and closes connection',async t=>{
  const {store}=await fixture(t);let invoked=false;
  assert.throws(()=>store.runUnit(true,async()=>{invoked=true;}),error=>error.code==='ASYNC_UNIT_REJECTED');assert.equal(invoked,false);
  assert.throws(()=>store.runUnit(true,()=>store.runUnit(false,()=>1)),error=>error.code==='NESTED_OR_CLOSED_UNIT');
  assert.throws(()=>store.runUnit(true,()=>Promise.resolve(1)),error=>error.code==='ASYNC_UNIT_REJECTED');
  assert.equal(store.db.open,false);
});

test('D07/C07 storage scope: full-source and mirrored-time tampering detected in disposable damaged copies',async t=>{
  for(const field of ['event_json','recorded_at']) {
    const f=await fixture(t);f.store.close();
    const db=new Database(f.file,{fileMustExist:true});
    db.exec('DROP TRIGGER clinical_no_update');
    if(field==='recorded_at') db.exec("UPDATE clinical_events SET recorded_at=recorded_at+1 WHERE event_id='evt_demo_stop'");
    else {
      const value=parseJSON(db.prepare("SELECT event_json FROM clinical_events WHERE event_id='evt_demo_stop'").get().event_json);
      value.source.quote='Altered fictional source';db.prepare("UPDATE clinical_events SET event_json=? WHERE event_id='evt_demo_stop'").run(JSON.stringify(value));
    }
    db.exec(schemaStatements.find(sql=>sql.startsWith('CREATE TRIGGER clinical_no_update')));db.close();
    assert.throws(()=>openDatabase(f.file,{verifyClinical:verifyChains}),error=>error.code==='CLINICAL_INTEGRITY_INVALID');
  }
});

test('D05 storage scope: terminate owned child after commit; restart keeps exactly one effect and receipt',{timeout:15000},async t=>{
  const f=await fixture(t);f.store.close();const operation=key();
  const script=`import {openDatabase} from './backend/db.js';import {verifyChains} from './backend/services/vault.js';
    import {appendAudit,putReceipt} from './backend/services/audit.js';
    const store=openDatabase(process.argv[1],{verifyClinical:verifyChains});const key=JSON.parse(process.argv[2]);
    store.runUnit(true,()=>{store.db.prepare("UPDATE rooms SET version=version+1 WHERE room_id='room_12'").run();
    appendAudit(store,{actor_id:'staff_demo',patient_id:null,encounter_id:null,operation:'QUEUE_TEST',result:'SUCCESS',recorded_at:Date.now(),details:{count:1}});
    putReceipt(store,key,{status:'OK',changed:true,version:1},Date.now());});process.send('COMMITTED');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script,f.file,JSON.stringify(operation)],
    {cwd:APP_ROOT,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  t.after(()=>{if(child.exitCode===null && !child.killed) child.kill();});
  const received=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error(`Child exited before commit: ${stderr}`);})]);
  assert.equal(received[0],'COMMITTED');const exited=once(child,'exit');child.kill();await exited;
  f.store=openDatabase(f.file,{verifyClinical:verifyChains});
  assert.equal(f.store.db.prepare("SELECT version FROM rooms WHERE room_id='room_12'").get().version,1);
  assert.equal(f.store.runUnit(false,()=>findReceipt(f.store,operation)).outcome.version,1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM mutation_receipts').get().n,1);
});
test.todo('D/A acceptance remaining: output races and storage fault recovery beyond controlled injections');
