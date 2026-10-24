import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { httpFixture } from './helpers.js';
import { cookieReference } from '../backend/auth.js';
import { ApiError } from '../backend/schemas.js';
import { appendAudit } from '../backend/services/audit.js';

async function actor(t,options) {
  const f=await httpFixture(t,options),login=await f.login();assert.equal(login.status,200);
  const ref=cookieReference(login.cookie),auth=f.app.locals.auth;
  return {...f,login,ref,auth,ops:f.app.locals.operations};
}
function command(f,key=randomUUID(),version=0) {
  return {method:'POST',path:'/api/v1/queue/rooms/room_12/pause',key,csrf:f.login.body.csrf_token,body:{expected_version:version}};
}
function changeRoom(f,intent) {
  return f.ops.executeCommand(f.ref,intent,()=>f.auth.room(f.ref,'room_12','queue:operate'),ctx=>{
    if(ctx.room.version!==intent.body.expected_version) throw new ApiError('STATE_VERSION_CONFLICT');
    f.store.db.prepare('UPDATE rooms SET version=version+1 WHERE room_id=?').run(ctx.room.room_id);
    return {status:'ROOM_VERSION_UPDATED',changed:true,room_id:ctx.room.room_id,version:ctx.room.version+1};
  },{audit:()=>({patient_id:null,encounter_id:null,operation:'TEST_COMMAND',result:'SUCCESS',details:{}})});
}
function grant(f) {
  const now=f.app.locals.now(),session=f.auth.authenticate(f.ref).session.session_id;
  f.store.runUnit(true,()=>{
    const audit=appendAudit(f.store,{actor_id:'clinician_12',patient_id:'patient_demo_ledger',encounter_id:'encounter_demo_ledger',
      operation:'TEST_BREAK_GLASS',result:'SUCCESS',recorded_at:now,details:{reason:'Fictional test only',mode:'BREAK_GLASS'}});
    f.store.db.prepare(`INSERT INTO encounter_grants VALUES('grant_operations',NULL,'encounter_demo_ledger','patient_demo_ledger','clinician_12',?,
      'facility_demo','OPD_CONSULTATION','["vault:query"]','BREAK_GLASS','ACTIVE',?,?,NULL,NULL,?,0)`).run(session,now,now+900000,audit);
  });
}
function protectedOptions(f,{intent,compute}={}) {
  return {intent,maxBytes:1024,authorize:()=>f.auth.encounter(f.ref,'encounter_demo_ledger',{scope:'vault:query'}),
    capture:(ctx,outcome)=>({source:{asOf:outcome?.as_of_sequence ?? 2},outcome:outcome ?? {status:'SOURCE_BOUND',changed:false,as_of_sequence:2}}),
    compute:compute ?? (async source=>{assert.equal(f.store.db.inTransaction,false);return {fictional:'private test answer',as_of_sequence:source.asOf};}),
    recheck:()=>{f.auth.encounter(f.ref,'encounter_demo_ledger',{scope:'vault:query'});},
    audit:()=>({patient_id:'patient_demo_ledger',encounter_id:'encounter_demo_ledger',operation:'TEST_PROTECTED_ACCESS',result:'SUCCESS',details:{}})};
}

test('A11/A12 coordinator scope: replay precedes new-state checks, current permission precedes receipt',async t=>{
  const f=await actor(t),intent=command(f);
  const first=await changeRoom(f,intent);assert.equal(first.version,1);assert.equal(first.replayed,false);
  assert.equal((await changeRoom(f,intent)).replayed,true);
  await assert.rejects(()=>changeRoom(f,command(f)),{code:'STATE_VERSION_CONFLICT'});
  await assert.rejects(()=>changeRoom(f,command(f,intent.key,1)),{code:'IDEMPOTENCY_CONFLICT'});
  f.store.runUnit(true,()=>f.store.db.prepare("UPDATE accounts SET permissions_json='[\"clinical:write\",\"emergency:read\"]' WHERE account_id='clinician_12'").run());
  await assert.rejects(()=>changeRoom(f,intent),{code:'SCOPE_DENIED'});
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE operation='TEST_COMMAND'").get().n,1);
  assert.equal(f.store.db.prepare('SELECT version FROM rooms WHERE room_id=?').get('room_12').version,1);
});

test('D05/S11 coordinator scope: audit failure rolls business and receipt back together',async t=>{
  const f=await actor(t),intent=command(f);
  f.store.db.exec("CREATE TRIGGER test_command_audit BEFORE INSERT ON audit_events WHEN NEW.operation='TEST_COMMAND' BEGIN SELECT RAISE(ABORT,'injected'); END");
  await assert.rejects(()=>changeRoom(f,intent),{code:'AUDIT_UNAVAILABLE',commit_state:'NOT_APPLIED'});
  assert.equal(f.store.db.prepare('SELECT version FROM rooms WHERE room_id=?').get('room_12').version,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM mutation_receipts WHERE idempotency_key=?').get(intent.key).n,0);
  f.store.db.exec('DROP TRIGGER test_command_audit');assert.equal((await changeRoom(f,intent)).version,1);
});

test('A11 coordinator scope: post-commit response loss reconciles exactly one business unit',async t=>{
  let once=true;const f=await actor(t,{hooks:{afterCommandCommit:()=>{if(once){once=false;throw new Error('lost');}}}}),intent=command(f);
  await assert.rejects(()=>changeRoom(f,intent),{code:'COMMIT_OUTCOME_UNKNOWN',commit_state:'UNKNOWN'});
  assert.equal((await changeRoom(f,intent)).replayed,true);
  assert.equal(f.store.db.prepare('SELECT version FROM rooms WHERE room_id=?').get('room_12').version,1);
});

test('S05/A12 protected coordinator scope: metadata receipts, per-read audit, final grant gate and no transaction during compute',async t=>{
  const f=await actor(t);grant(f);const intent={...command(f),path:'/api/v1/vault/query',body:{topic_key:'allergies'}};
  const first=await f.ops.readProtected(f.ref,protectedOptions(f,{intent}));
  assert.equal(JSON.parse(first.release()).fictional,'private test answer');assert.throws(()=>first.release(),{code:'INVALID_TRANSITION'});
  const replay=await f.ops.readProtected(f.ref,protectedOptions(f,{intent}));assert.equal(JSON.parse(replay.release()).as_of_sequence,2);
  const receipt=f.store.db.prepare('SELECT outcome_json FROM mutation_receipts WHERE idempotency_key=?').get(intent.key).outcome_json;
  assert.equal(receipt.includes('private test answer'),false);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE operation='TEST_PROTECTED_ACCESS'").get().n,2);
  const held=await f.ops.readProtected(f.ref,protectedOptions(f,{intent}));
  f.store.runUnit(true,()=>f.store.db.prepare("UPDATE encounter_grants SET state='REVOKED',ended_at=?,end_reason='TEST_REVOKED',version=version+1 WHERE grant_id='grant_operations'").run(f.app.locals.now()));
  assert.throws(()=>held.release(),{code:'GRANT_ENDED'});
  await assert.rejects(()=>f.ops.readProtected(f.ref,protectedOptions(f,{intent})),{code:'GRANT_ENDED'});
});

test('S05/S11 protected coordinator scope: revocation during compute and audit failure release no buffer or receipt',async t=>{
  const f=await actor(t);grant(f);const intent={...command(f),path:'/api/v1/vault/query',body:{topic_key:'allergies'}};
  await assert.rejects(()=>f.ops.readProtected(f.ref,protectedOptions(f,{intent,compute:async()=>{
    await f.request('/api/v1/auth/logout',{method:'POST',cookie:f.login.cookie,csrf:f.login.body.csrf_token,body:{}});
    return {fictional:'must not release'};
  }})),{code:'SESSION_ENDED'});
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM mutation_receipts WHERE idempotency_key=?').get(intent.key).n,0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE operation='TEST_PROTECTED_ACCESS'").get().n,0);
  const other=await actor(t);grant(other);
  other.store.db.exec("CREATE TRIGGER test_access_audit BEFORE INSERT ON audit_events WHEN NEW.operation='TEST_PROTECTED_ACCESS' BEGIN SELECT RAISE(ABORT,'injected'); END");
  const next={...command(other),path:'/api/v1/vault/query',body:{topic_key:'allergies'}};
  await assert.rejects(()=>other.ops.readProtected(other.ref,protectedOptions(other,{intent:next})),{code:'AUDIT_UNAVAILABLE'});
  assert.equal(other.store.db.prepare('SELECT COUNT(*) n FROM mutation_receipts WHERE idempotency_key=?').get(next.key).n,0);
});

test('A11 protected coordinator scope: simultaneous identical intents reconstruct winning metadata once',async t=>{
  const f=await actor(t);grant(f);const intent={...command(f),path:'/api/v1/vault/query',body:{topic_key:'allergies'}};
  let entered,release;const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  let captures=0;
  const options=protectedOptions(f,{intent,compute:async source=>{
    if(source.asOf===1){entered();await gate;}return {as_of_sequence:source.asOf};
  }});
  options.capture=(ctx,outcome)=>{captures+=1;const selected=outcome ?? {status:'SOURCE_BOUND',changed:false,as_of_sequence:captures};
    return {source:{asOf:selected.as_of_sequence},outcome:selected};};
  const slow=f.ops.readProtected(f.ref,options);await ready;
  const winner=await f.ops.readProtected(f.ref,options);assert.equal(JSON.parse(winner.release()).as_of_sequence,2);release();
  const loser=await slow;assert.equal(JSON.parse(loser.release()).as_of_sequence,2);assert.equal(captures,3);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM mutation_receipts WHERE idempotency_key=?').get(intent.key).n,1);
});
