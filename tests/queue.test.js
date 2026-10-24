import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createApp } from '../backend/app.js';
import { verifyStorage } from '../backend/db.js';
import { findRoute } from '../backend/services/queue.js';
import { httpFixture, actorClient } from './helpers.js';

const version=(f,room='room_12')=>f.store.db.prepare('SELECT version FROM rooms WHERE room_id=?').get(room).version;
const person=(room='room_12',name='Fictional registered patient')=>({room_id:room,intake_mode:'MANUAL',patient:{display_name:name,language:'en'}});
const tokenPath=(token,action)=>`/api/v1/queue/tokens/${token}/${action}`;
const encounterPath=(encounter,action)=>`/api/v1/encounters/${encounter}/${action}`;
async function register(staff,room,name) {const r=await staff.post('/api/v1/queue/register',person(room,name));assert.equal(r.status,200,r.body.error);return r.body;}
async function finish(f,doctor,encounter='encounter_demo_ledger',room='room_12') {
  const r=await doctor.post(encounterPath(encounter,'complete'),{expected_version:version(f,room)});assert.equal(r.status,200,r.body.error);return r.body;
}
async function call(f,actor,room='room_12') {
  const r=await actor.post(`/api/v1/queue/rooms/${room}/call-next`,{expected_version:version(f,room)});assert.equal(r.status,200,r.body.error);return r.body;
}
async function repeat(f,actor,called) {
  const r=await actor.post(tokenPath(called.token_id,'repeat-call'),{encounter_id:called.encounter_id,expected_version:version(f)});assert.equal(r.status,200,r.body.error);
}
// Consistent fictional absence checkpoint for ordering examples; recall itself uses HTTP.
function seedAbsent(f,room,label) {
  const suffix=randomUUID(),time=f.app.locals.now(),patient=`patient_${suffix}`,visit=`visit_${suffix}`,token=`token_${suffix}`;
  f.store.runUnit(true,()=>{
    f.store.db.prepare('INSERT INTO patients VALUES(?,?,NULL,?,NULL,?)').run(patient,`Fictional ${label}`,'en',time);
    f.store.db.prepare("INSERT INTO visits VALUES(?,?,?,?,?,'SKIPPED_ABSENT',NULL,'{}',NULL,?)").run(visit,patient,token,label,room,time);
    f.store.db.prepare("INSERT INTO encounters VALUES(?,?,?,?,?,?,3,?,NULL,NULL,?,'ABSENT')").run(`encounter_${suffix}`,visit,patient,room,
      room==='room_12'?'clinician_12':'clinician_18',time-1000,time-500,time-100);
  });return {token_id:token};
}

test('Q01/A11 HTTP: registration response loss replays one token; strict intake, local patient linking and simulation labels',async t=>{
  let once=true;const f=await httpFixture(t,{hooks:{afterCommandCommit:()=>{if(once){once=false;throw new Error('lost response');}}}}),staff=await actorClient(f);
  const body=person(),key=randomUUID(),before=f.store.db.prepare('SELECT COUNT(*) n FROM visits').get().n;
  const lost=await staff.post('/api/v1/queue/register',body,{key});assert.equal(lost.body.commit_state,'UNKNOWN');
  const replay=await staff.post('/api/v1/queue/register',body,{key});assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM visits').get().n,before+1);assert.equal(version(f),1);
  assert.equal((await staff.post('/api/v1/queue/register',{...body,room_id:'room_18'},{key})).body.error,'IDEMPOTENCY_CONFLICT');
  assert.equal((await staff.post('/api/v1/queue/register',{room_id:'room_12',intake_mode:'MANUAL',patient_id:'patient_demo_waiting'})).body.error,'ACTIVE_VISIT_EXISTS');
  for(const bad of [{...body,patient_id:'patient_demo_waiting'},{...body,actor_id:'staff_demo'},{...body,demo_identifier:'unverified'},
    {...body,patient:{...body.patient,date_of_birth:'2999-01-01'}}]) assert.equal((await staff.post('/api/v1/queue/register',bad)).status,422);
  const simulated=await staff.post('/api/v1/queue/register',{...person('room_18'),intake_mode:'SIMULATED_ABHA',demo_identifier:'FICTIONAL-QR'});
  assert.equal(simulated.status,200);
  assert.equal(JSON.parse(f.store.db.prepare('SELECT intake_json FROM visits WHERE token_id=?').get(simulated.body.token_id).intake_json).simulation_label,'SIMULATED_ABHA_NOT_VERIFIED');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM clinical_events').get().n,3);
});

test('Q02 HTTP: competing calls from one version create exactly one current encounter',async t=>{
  const f=await httpFixture(t),staff=await actorClient(f),doctor=await actorClient(f,'doctor12');await finish(f,doctor);
  const body={expected_version:version(f)},keys=[randomUUID(),randomUUID()];
  const results=await Promise.all([staff.post('/api/v1/queue/rooms/room_12/call-next',body,{key:keys[0]}),doctor.post('/api/v1/queue/rooms/room_12/call-next',body,{key:keys[1]})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM encounters WHERE room_id='room_12' AND closed_at IS NULL").get().n,1);
  const winner=results.findIndex(r=>r.status===200),actor=winner===0?staff:doctor;
  const replay=await actor.post('/api/v1/queue/rooms/room_12/call-next',body,{key:keys[winner]});assert.equal(replay.body.replayed,true);
  assert.equal(replay.body.encounter_id,results[winner].body.encounter_id);assert.equal(version(f),2);
});

test('Q03 HTTP: call retries are silent; three recorded calls then confirmed absence atomically advances once',async t=>{
  const f=await httpFixture(t),staff=await actorClient(f),doctor=await actorClient(f,'doctor12');await finish(f,doctor);
  const called=await call(f,staff),next=await register(staff);
  const key=randomUUID(),body={encounter_id:called.encounter_id,expected_version:version(f)};
  assert.equal((await staff.post(tokenPath(called.token_id,'repeat-call'),body,{key})).status,200);
  const firstDisplay=await f.request('/api/v1/queue/display/room_12');
  assert.equal((await staff.post(tokenPath(called.token_id,'repeat-call'),body,{key})).body.replayed,true);
  assert.equal((await f.request('/api/v1/queue/display/room_12')).body.announcement.announcement_id,firstDisplay.body.announcement.announcement_id);
  assert.equal((await staff.post(tokenPath(called.token_id,'absent'),{encounter_id:called.encounter_id,expected_version:version(f),absence_confirmed:true})).status,409);
  await repeat(f,staff,called);
  assert.equal((await staff.post(tokenPath(called.token_id,'repeat-call'),{encounter_id:called.encounter_id,expected_version:version(f)})).status,409);
  const absentKey=randomUUID(),absentBody={encounter_id:called.encounter_id,expected_version:version(f),absence_confirmed:true},previous=version(f);
  const absent=await staff.post(tokenPath(called.token_id,'absent'),absentBody,{key:absentKey});assert.equal(absent.status,200);
  assert.equal(absent.body.called_token_id,next.token_id);assert.ok(absent.body.called_encounter_id);assert.equal(version(f),previous+1);
  assert.equal((await staff.post(tokenPath(called.token_id,'absent'),absentBody,{key:absentKey})).body.called_encounter_id,absent.body.called_encounter_id);
  const display=(await f.request('/api/v1/queue/display/room_12')).body;assert.equal(display.current.public_token,next.public_token);assert.equal(display.announcement.call_number,1);
  assert.equal(f.store.db.prepare('SELECT call_attempts,closure_reason FROM encounters WHERE encounter_id=?').get(called.encounter_id).closure_reason,'ABSENT');
});

test('Q04/Q10 HTTP: check-in is separate from permission; checked-in patients cannot be marked absent or withdrawn by staff',async t=>{
  const f=await httpFixture(t),staff=await actorClient(f),doctor=await actorClient(f,'doctor12');await finish(f,doctor);const called=await call(f,staff);
  const key=randomUUID(),body={expected_version:version(f),identity_check_confirmed:true};
  assert.equal((await staff.post(encounterPath(called.encounter_id,'check-in'),{...body,identity_check_confirmed:false})).status,422);
  assert.equal((await staff.post(encounterPath(called.encounter_id,'check-in'),body,{key})).status,200);
  assert.equal((await staff.post(encounterPath(called.encounter_id,'check-in'),body,{key})).body.replayed,true);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM encounter_grants').get().n,0);
  assert.equal((await staff.post(encounterPath(called.encounter_id,'check-in'),{...body,expected_version:version(f)})).status,409);
  assert.equal((await staff.post(tokenPath(called.token_id,'absent'),{encounter_id:called.encounter_id,expected_version:version(f),absence_confirmed:true})).status,409);
  assert.equal((await staff.post(tokenPath(called.token_id,'withdraw'),{encounter_id:called.encounter_id,expected_version:version(f),reason:'Fictional withdrawal'})).status,403);
  await finish(f,doctor,called.encounter_id);assert.equal((await staff.get('/api/v1/queue/rooms/room_12')).body.current,null);
});

test('Q05 HTTP: confirmed returns are FIFO ahead of ordinary waiting without preempting current care',async t=>{
  const f=await httpFixture(t),staff=await actorClient(f),doctor=await actorClient(f,'doctor12'),patient=await actorClient(f,'patient-d');
  const a=await register(staff),b=await register(staff);await finish(f,doctor);const c=await call(f,staff);await repeat(f,staff,c);await repeat(f,staff,c);
  assert.equal((await staff.post(tokenPath(c.token_id,'absent'),{encounter_id:c.encounter_id,expected_version:version(f),absence_confirmed:true})).status,200);
  for(const token of ['token_demo_4',c.token_id]) assert.equal((await staff.post(tokenPath(token,'recall'),{expected_version:version(f),return_confirmed:true})).status,200);
  const view=(await staff.get('/api/v1/queue/rooms/room_12')).body;
  assert.equal(view.current.token_id,a.token_id);assert.deepEqual(view.waiting.map(v=>v.token_id),['token_demo_4',c.token_id,b.token_id]);
  assert.deepEqual(view.waiting.map(v=>v.people_ahead),[1,2,3]);
  assert.equal((await patient.post(tokenPath('token_demo_4','recall'),{expected_version:version(f),return_confirmed:true})).status,404);
  assert.equal((await doctor.post(tokenPath('token_demo_4','recall'),{expected_version:version(f),return_confirmed:true})).status,403);
});

test('Q06 HTTP ordering examples: transfers move at most two ordinary positions and never cross recalls',async t=>{
  for(const scenario of [{ordinary:4,recalls:0,expected:['A','B','T','C','D']},{ordinary:2,recalls:2,expected:['R1','R2','T','A','B']},
    {ordinary:1,recalls:1,expected:['R1','T','A']},{ordinary:2,recalls:2,noTransfer:true,expected:['R1','R2','A','B']},
    {ordinary:4,recalls:0,second:true,expected:['A','B','T','U','C','D']}]) {
    await t.test(scenario.expected.join(' '),async s=>{
      const f=await httpFixture(s),staff=await actorClient(f),doctor=await actorClient(f,'doctor12'),names={};
      for(let i=0;i<scenario.ordinary;i++) {const name=String.fromCharCode(65+i);names[name]=(await register(staff,'room_18',`Fictional ${name}`)).token_id;}
      for(let i=1;i<=scenario.recalls;i++) {
        const value=seedAbsent(f,'room_18',`R${i}`);names[`R${i}`]=value.token_id;
        assert.equal((await staff.post(tokenPath(value.token_id,'recall'),{expected_version:version(f,'room_18'),return_confirmed:true})).status,200);
      }
      async function transfer(token,encounter) {
        const r=await doctor.post(tokenPath(token,'transfer'),{encounter_id:encounter,expected_version:version(f),target_room_id:'room_18',expected_target_version:version(f,'room_18'),reason:'Fictional referral'});
        assert.equal(r.status,200,r.body.error);return r.body;
      }
      if(!scenario.noTransfer) {names.T='token_demo_1';const moved=await transfer(names.T,'encounter_demo_ledger');assert.equal(moved.people_ahead,moved.waiting_position);}
      if(scenario.second) {
        const next=await call(f,staff);assert.equal((await staff.post(encounterPath(next.encounter_id,'check-in'),{expected_version:version(f),identity_check_confirmed:true})).status,200);
        names.U=next.token_id;await transfer(names.U,next.encounter_id);
      }
      const view=(await staff.get('/api/v1/queue/rooms/room_18')).body;
      assert.deepEqual(view.waiting.map(v=>v.token_id),scenario.expected.map(name=>names[name]));assert.equal(view.current.token_id,'token_demo_2');
      assert.deepEqual(view.waiting.map(v=>v.waiting_position),view.waiting.map((_,i)=>i+1));
      f.store.runUnit(false,()=>verifyStorage(f.store.db));
    });
  }
});

test('Q07 HTTP: transfer audit failure rolls both rooms, closure, access and receipt back; moved-token replay retains source binding',async t=>{
  const f=await httpFixture(t),doctor=await actorClient(f,'doctor12'),patient=await actorClient(f,'patient-a'),staff=await actorClient(f);
  const request=await doctor.post(encounterPath('encounter_demo_ledger','allowance/request'),{explanation:'Fictional consultation review'});assert.equal(request.status,200,request.body.error);
  const allowed=await patient.post(encounterPath('encounter_demo_ledger','allowance/respond'),{consent_request_id:request.body.consent_request_id,expected_request_version:0,action:'ALLOW',approval_channel:'PHONE'});
  assert.equal(allowed.status,200,allowed.body.error);const key=randomUUID(),body={encounter_id:'encounter_demo_ledger',expected_version:version(f),target_room_id:'room_18',expected_target_version:version(f,'room_18'),reason:'Fictional referral'};
  f.store.db.exec("CREATE TRIGGER fail_transfer BEFORE INSERT ON audit_events WHEN NEW.operation='QUEUE_TRANSFER' BEGIN SELECT RAISE(ABORT,'injected'); END");
  const failed=await doctor.post(tokenPath('token_demo_1','transfer'),body,{key});assert.equal(failed.body.error,'AUDIT_UNAVAILABLE');
  assert.equal(f.store.db.prepare('SELECT closed_at FROM encounters WHERE encounter_id=?').get(body.encounter_id).closed_at,null);
  assert.equal(f.store.db.prepare('SELECT state FROM encounter_grants WHERE grant_id=?').get(allowed.body.grant_id).state,'ACTIVE');assert.equal(version(f),0);assert.equal(version(f,'room_18'),0);
  f.store.db.exec('DROP TRIGGER fail_transfer');
  const moved=await doctor.post(tokenPath('token_demo_1','transfer'),body,{key});assert.equal(moved.status,200,moved.body.error);
  assert.equal(f.store.db.prepare('SELECT state FROM encounter_grants WHERE grant_id=?').get(allowed.body.grant_id).state,'ENDED');
  const replay=await doctor.post(tokenPath('token_demo_1','transfer'),body,{key});assert.equal(replay.body.replayed,true);assert.equal(version(f),1);assert.equal(version(f,'room_18'),1);
  assert.equal((await doctor.post(tokenPath('token_demo_1','withdraw'),{encounter_id:body.encounter_id,expected_version:version(f),reason:'Stale encounter'})).status,409);
});

test('Q08 HTTP: pause permits intake/recall/transfer/completion; resume preserves FIFO and never calls automatically',async t=>{
  const f=await httpFixture(t),staff=await actorClient(f),d12=await actorClient(f,'doctor12'),d18=await actorClient(f,'doctor18');
  assert.equal((await d18.post('/api/v1/queue/rooms/room_18/pause',{expected_version:0})).status,200);
  await register(staff,'room_18');
  assert.equal((await d12.post(tokenPath('token_demo_1','transfer'),{encounter_id:'encounter_demo_ledger',expected_version:0,target_room_id:'room_18',expected_target_version:version(f,'room_18'),reason:'Fictional referral'})).status,200);
  const parked=seedAbsent(f,'room_18','Fictional-return');assert.equal((await staff.post(tokenPath(parked.token_id,'recall'),{expected_version:version(f,'room_18'),return_confirmed:true})).status,200);
  await finish(f,d18,'encounter_demo_negative','room_18');const before=(await staff.get('/api/v1/queue/rooms/room_18')).body;
  assert.equal(before.current,null);assert.equal((await staff.post('/api/v1/queue/rooms/room_18/call-next',{expected_version:version(f,'room_18')})).status,409);
  assert.equal((await staff.post('/api/v1/queue/rooms/room_18/resume',{expected_version:version(f,'room_18')})).status,200);
  const after=(await staff.get('/api/v1/queue/rooms/room_18')).body;assert.equal(after.current,null);assert.deepEqual(after.waiting,before.waiting);
  assert.equal((await call(f,staff,'room_18')).token_id,parked.token_id);
});

test('Q10/Q12 HTTP: terminal withdrawal, public privacy, patient card ownership and accessible sample navigation',async t=>{
  const f=await httpFixture(t),staff=await actorClient(f),patient=await actorClient(f,'patient-c'),doctor=await actorClient(f,'doctor12');
  const card=(await patient.get('/api/v1/patients/me/visit')).body.visit;assert.equal(card.patient_id,'patient_demo_waiting');assert.equal(card.people_ahead,1);
  assert.equal((await staff.get('/api/v1/patients/me/visit')).status,403);assert.equal((await f.request('/api/v1/patients/me/visit')).status,401);
  const body={expected_version:version(f),reason:'Fictional withdrawal'},key=randomUUID();
  assert.equal((await staff.post(tokenPath('token_demo_3','withdraw'),body,{key})).status,200);
  assert.equal((await staff.post(tokenPath('token_demo_3','withdraw'),body,{key})).body.replayed,true);
  assert.equal((await staff.post(tokenPath('token_demo_3','withdraw'),{...body,expected_version:version(f)})).status,409);
  assert.equal((await patient.get('/api/v1/patients/me/visit')).body.visit.people_ahead,null);
  const display=(await f.request('/api/v1/queue/display/room_12')).body;
  const forbidden=['patient_id','display_name','visit_id','token_id','encounter_id','grant_id','consent_request_id','csrf_token','absent'];
  function inspect(value) {if(value && typeof value==='object')for(const [key,child] of Object.entries(value)){assert.equal(forbidden.includes(key),false,key);inspect(child);}}
  inspect(display);assert.equal((await doctor.get('/api/v1/queue/rooms/room_18')).status,404);
  const route=await f.request('/api/v1/navigation/route?origin=entrance&destination=room_18&accessibility=STEP_FREE&language=hi');
  assert.equal(route.status,200);assert.equal(route.body.status,'ROUTE_AVAILABLE');assert.ok(route.body.steps.some(step=>step.to==='lift'));
  assert.ok(route.body.steps.every(step=>typeof step.instruction==='string'));assert.equal(route.body.warning,'FICTIONAL_SAMPLE_MAP_NOT_SURVEYED');
  assert.equal((await f.request('/api/v1/navigation/route?origin=unknown&destination=room_18')).status,422);
  assert.equal((await f.request('/api/v1/navigation/route?origin=entrance&origin=room_12&destination=room_18')).status,422);
  const disconnected=structuredClone(f.app.locals.fixtures.map);disconnected.edges.find(edge=>edge.from==='lift' && edge.to==='upper').step_free=false;
  const none=findRoute(disconnected,{origin:'entrance',destination:'room_18',accessibility:'STEP_FREE',language:'en'});
  assert.equal(none.status,'NO_CONFIGURED_ROUTE');assert.deepEqual(none.steps,[]);
});

test('Q01/Q07 capacity HTTP: 100 unresolved visits includes current/absent; full target rejects intake and transfer atomically',async t=>{
  const f=await httpFixture(t),staff=await actorClient(f),doctor=await actorClient(f,'doctor12');
  for(const room of ['room_12','room_18']) {
    const initial=f.store.db.prepare("SELECT COUNT(*) n FROM visits WHERE room_id=? AND queue_state NOT IN ('COMPLETED','CANCELLED')").get(room).n;
    for(let i=initial;i<100;i++) await register(staff,room,`Fictional capacity ${i}`);
    assert.equal((await staff.post('/api/v1/queue/register',person(room))).body.error,'QUEUE_CAPACITY_REACHED');
  }
  const number=f.store.db.prepare('SELECT next_token_number FROM schema_meta').get().next_token_number;
  assert.equal((await staff.post('/api/v1/queue/register',person('room_18'))).body.error,'QUEUE_CAPACITY_REACHED');
  assert.equal((await doctor.post(tokenPath('token_demo_1','transfer'),{encounter_id:'encounter_demo_ledger',expected_version:version(f),target_room_id:'room_18',expected_target_version:version(f,'room_18'),reason:'Fictional referral'})).body.error,'QUEUE_CAPACITY_REACHED');
  assert.equal(f.store.db.prepare('SELECT next_token_number FROM schema_meta').get().next_token_number,number);
  assert.equal(f.store.db.prepare("SELECT closed_at FROM encounters WHERE encounter_id='encounter_demo_ledger'").get().closed_at,null);
  assert.equal((await staff.get('/api/v1/queue/rooms/room_18')).body.waiting.length,99);
  const full=(await staff.get('/api/v1/queue/rooms/room_12')).body;assert.equal(full.waiting.length+full.absent.length+Number(Boolean(full.current)),100);
});

test('Q07 HTTP: transfer racing with destination call respects both versions without a half-move',async t=>{
  const f=await httpFixture(t),staff=await actorClient(f),d12=await actorClient(f,'doctor12'),d18=await actorClient(f,'doctor18');
  await finish(f,d18,'encounter_demo_negative','room_18');await register(staff,'room_18');
  const targetVersion=version(f,'room_18');
  const [moved,called]=await Promise.all([
    d12.post(tokenPath('token_demo_1','transfer'),{encounter_id:'encounter_demo_ledger',expected_version:version(f),target_room_id:'room_18',expected_target_version:targetVersion,reason:'Fictional referral'}),
    staff.post('/api/v1/queue/rooms/room_18/call-next',{expected_version:targetVersion}),
  ]);
  assert.deepEqual([moved.status,called.status].sort(),[200,409]);
  assert.equal(f.store.db.prepare("SELECT room_id FROM visits WHERE token_id='token_demo_1'").get().room_id,moved.status===200?'room_18':'room_12');
  f.store.runUnit(false,()=>verifyStorage(f.store.db));
});

test('Q08 HTTP: a paused room blocks repeat calls and does not auto-call after confirmed absence',async t=>{
  const f=await httpFixture(t),staff=await actorClient(f),doctor=await actorClient(f,'doctor12');await finish(f,doctor);
  const called=await call(f,staff);await repeat(f,staff,called);await repeat(f,staff,called);await register(staff);
  assert.equal((await staff.post('/api/v1/queue/rooms/room_12/pause',{expected_version:version(f),estimated_return_at:new Date(Date.now()-1000).toISOString()})).status,422);
  const estimated=new Date(Date.now()+60000).toISOString();
  assert.equal((await staff.post('/api/v1/queue/rooms/room_12/pause',{expected_version:version(f),estimated_return_at:estimated})).status,200);
  const absent=await staff.post(tokenPath(called.token_id,'absent'),{encounter_id:called.encounter_id,expected_version:version(f),absence_confirmed:true});
  assert.equal(absent.status,200);assert.equal(absent.body.called_token_id,null);
  const paused=(await f.request('/api/v1/queue/display/room_12')).body;assert.equal(paused.current,null);assert.equal(paused.waiting.length,1);assert.equal(paused.estimated_return_at,estimated);
  assert.equal((await staff.post('/api/v1/queue/rooms/room_12/resume',{expected_version:version(f)})).status,200);
  assert.equal((await f.request('/api/v1/queue/display/room_12')).body.estimated_return_at,null);
});

test('Q11 HTTP restart: committed command receipt and original session deadline survive ordinary reopen',async t=>{
  const f=await httpFixture(t),staff=await actorClient(f),key=randomUUID(),body=person();
  const first=await staff.post('/api/v1/queue/register',body,{key});assert.equal(first.status,200);
  const deadline=staff.login.body.expires_at;await f.cleanup();
  const app=await createApp(f.settings),server=http.createServer(app);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/queue/register`,{method:'POST',headers:{Origin:f.origin,
      'Content-Type':'application/json','X-Idempotency-Key':key,'X-CSRF-Token':staff.login.body.csrf_token,Cookie:staff.login.cookie},body:JSON.stringify(body)});
    const replay=await response.json();assert.equal(response.status,200);assert.equal(replay.replayed,true);assert.equal(replay.token_id,first.body.token_id);
    assert.equal(app.locals.store.db.prepare('SELECT expires_at FROM sessions').get().expires_at,Date.parse(deadline));
  } finally {await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});app.locals.close();}
});

test('Q03 HTTP no-op: empty call persists unchanged outcome and keeps state-change time stable',async t=>{
  const f=await httpFixture(t),doctor=await actorClient(f,'doctor18');await finish(f,doctor,'encounter_demo_negative','room_18');
  const before=(await f.request('/api/v1/queue/display/room_18')).body,key=randomUUID(),body={expected_version:version(f,'room_18')};
  const first=await doctor.post('/api/v1/queue/rooms/room_18/call-next',body,{key});assert.equal(first.body.status,'NO_WAITING_TOKEN');assert.equal(first.body.changed,false);
  const after=(await f.request('/api/v1/queue/display/room_18')).body;assert.equal(after.version,before.version);assert.equal(after.state_changed_at,before.state_changed_at);
  assert.equal((await doctor.post('/api/v1/queue/rooms/room_18/call-next',body,{key})).body.replayed,true);
});

test.todo('Q11/Q12 browser coverage remaining: connected polling, silent announcement baseline, stale views and text/print fallback');
