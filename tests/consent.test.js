import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { httpFixture, actorClient } from './helpers.js';
import { cookieReference } from '../backend/auth.js';

const encounter='encounter_demo_ledger';
const path=action=>`/api/v1/encounters/${encounter}/allowance/${action}`;
const assistance={patient_present:true,identity_check_confirmed:true,patient_choice_confirmed:true};
async function request(doctor,body={explanation:'Review fictional history for this consultation.'}) {
  const r=await doctor.post(path('request'),body);assert.equal(r.status,200,r.body.error);return r.body;
}
const decision=(q,action='ALLOW',extra={})=>({consent_request_id:q.consent_request_id,expected_request_version:q.request_version,
  action,approval_channel:'PHONE',...extra});
async function setup(t,options) {
  const f=await httpFixture(t,options);return {...f,doctor:await actorClient(f,'doctor12'),patient:await actorClient(f,'patient-a'),staff:await actorClient(f)};
}
function queryPermission(f) {return f.store.runUnit(false,()=>f.app.locals.auth.encounter(cookieReference(f.doctor.login.cookie),encounter,{scope:'vault:query'}));}

test('S04–S06 HTTP: participant binding, Ask Why/clarify/deny and equivalent pending metadata preserve deadline and queue',async t=>{
  const f=await setup(t),other=await actorClient(f,'patient-b'),wrongDoctor=await actorClient(f,'doctor18'),q=await request(f.doctor);
  const initial=await f.doctor.get(path('status'));assert.equal(initial.body.clinical_data,null);assert.equal(initial.body.authorization_state,'LOCKED');
  assert.deepEqual(initial.body.request.scopes,['triage:read','vault:query','affirmation:run','summary:export']);
  const duplicate=await request(f.doctor);assert.equal(duplicate.changed,false);assert.equal(duplicate.consent_request_id,q.consent_request_id);assert.equal(duplicate.request_expires_at,q.request_expires_at);
  assert.equal((await other.post(path('respond'),decision(q))).status,404);
  assert.equal((await wrongDoctor.get(path('status'))).status,404);
  assert.equal((await f.doctor.post(path('respond'),decision(q))).status,403);
  const asked=await f.patient.post(path('respond'),decision(q,'ASK_WHY',{note:'Please explain the purpose.'}));assert.equal(asked.status,200,asked.body.error);
  assert.equal(asked.body.request_state,'CLARIFICATION_REQUESTED');assert.equal(asked.body.request_expires_at,q.request_expires_at);assert.throws(()=>queryPermission(f),{code:'HISTORY_LOCKED'});
  const status=(await f.doctor.get(path('status'))).body;assert.equal(status.request.clarification_note,'Please explain the purpose.');
  const clarify=await f.doctor.post(path('clarify'),{consent_request_id:q.consent_request_id,expected_request_version:1,explanation:'Only the displayed clinical scopes for this fictional visit.'});
  assert.equal(clarify.status,200);assert.equal(clarify.body.request_version,2);assert.equal(clarify.body.request_expires_at,q.request_expires_at);
  const denied=await f.patient.post(path('respond'),decision({...q,request_version:2},'DENY'));assert.equal(denied.status,200);assert.equal(denied.body.request_state,'DENIED');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM encounter_grants').get().n,0);
  assert.equal(f.store.db.prepare("SELECT version FROM rooms WHERE room_id='room_12'").get().version,0);
  assert.equal(f.store.db.prepare("SELECT queue_state FROM visits WHERE token_id='token_demo_1'").get().queue_state,'IN_CONSULTATION');
  const next=await request(f.doctor);assert.notEqual(next.consent_request_id,q.consent_request_id);assert.equal(next.request_version,0);
});

test('S05 HTTP: independent assistance records actual choices and server identity; copied references and fabricated actors confer no authority',async t=>{
  const f=await setup(t),q=await request(f.doctor),assisted=decision(q,'ASK_WHY',{approval_channel:'ASSISTED_QR',assistance,note:'Explain this fictional request.'});
  assert.equal((await f.doctor.post(path('respond'),assisted)).status,403);
  assert.equal((await f.staff.post(path('respond'),{...assisted,assistance:undefined})).status,403);
  assert.equal((await f.patient.post(path('respond'),decision(q,'ALLOW',{assistance}))).status,403);
  assert.equal((await f.staff.post(path('respond'),{...assisted,assistant_id:'staff_demo'})).status,422);
  assert.equal((await f.staff.post(path('respond'),assisted)).status,200);
  const denied=await f.staff.post(path('respond'),decision({...q,request_version:1},'DENY',{approval_channel:'ASSISTED_QR',assistance}));assert.equal(denied.status,200);
  const stored=f.store.db.prepare('SELECT assistance_json,state,decision_actor_id FROM consent_requests WHERE request_id=?').get(q.consent_request_id);
  assert.equal(stored.state,'DENIED');assert.equal(stored.decision_actor_id,'staff_demo');
  assert.equal(JSON.parse(stored.assistance_json).assistant_id,'staff_demo');assert.ok(JSON.parse(stored.assistance_json).assistant_session_id);
  const next=await request(f.doctor),allowed=await f.staff.post(path('respond'),decision(next,'ALLOW',{approval_channel:'ASSISTED_QR',assistance}));
  assert.equal(allowed.status,200,allowed.body.error);assert.equal(allowed.body.mode,'PATIENT_APPROVED');assert.ok(allowed.body.grant_id.startsWith('tok_enc_'));
  const authorization=f.store.db.prepare('SELECT * FROM audit_events WHERE audit_id=?').get(allowed.body.authorization_event_id);
  assert.equal(authorization.actor_id,'staff_demo');assert.equal(JSON.parse(authorization.details_json).patient_choice,'ALLOW');
  assert.equal((await f.staff.get(path('status'))).body.clinical_data,null);assert.equal(allowed.text.includes('Ecosprin'),false);
  assert.equal((await f.request(path('status'),{headers:{Authorization:`Bearer ${allowed.body.grant_id}`}})).status,401);
  const revoked=await f.staff.post(path('revoke'),{grant_id:allowed.body.grant_id,expected_grant_version:0,approval_channel:'ASSISTED_QR',assistance,reason:'Patient chose to stop sharing.'});
  assert.equal(revoked.status,200);assert.equal(revoked.body.grant_state,'REVOKED');assert.throws(()=>queryPermission(f),{code:'GRANT_ENDED'});
});

test('S06 HTTP exact 300-second boundary: Ask Why/clarify never extend; effective expiry is read-only and a fresh request needs a new choice',async t=>{
  let time=Date.now()+1000;const f=await setup(t,{clock:{utc:()=>time,mono:()=>time}}),q=await request(f.doctor),deadline=Date.parse(q.request_expires_at);
  assert.equal(deadline-time,300000);time+=100000;
  assert.equal((await f.patient.post(path('respond'),decision(q,'ASK_WHY',{note:'Why these scopes?'}))).status,200);
  time+=100000;const clarified=await f.doctor.post(path('clarify'),{consent_request_id:q.consent_request_id,expected_request_version:1,explanation:'Fictional consultation context.'});
  assert.equal(clarified.body.request_expires_at,q.request_expires_at);time=deadline;
  const status=(await f.patient.get(path('status'))).body;assert.equal(status.request.request_state,'EXPIRED');assert.equal(status.request.remaining_seconds,0);
  assert.equal(f.store.db.prepare('SELECT state FROM consent_requests').get().state,'REQUESTED');
  assert.equal((await f.patient.post(path('respond'),decision({...q,request_version:2}))).body.error,'CONSENT_REQUEST_ENDED');
  const fresh=await request(f.doctor);assert.notEqual(fresh.consent_request_id,q.consent_request_id);assert.equal(fresh.request_state,'REQUESTED');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM encounter_grants').get().n,0);
});

test('S07 HTTP exact 900-second boundary: replay and repeated request preserve expiry and report current effective state',async t=>{
  let time=Date.now()+1000;const f=await setup(t,{clock:{utc:()=>time,mono:()=>time}}),q=await request(f.doctor),body=decision(q),key=randomUUID();
  const allowed=await f.patient.post(path('respond'),body,{key});assert.equal(allowed.status,200,allowed.body.error);
  const deadline=Date.parse(allowed.body.expires_at);assert.equal(deadline-time,900000);assert.ok(queryPermission(f).grant);
  time+=500000;const duplicate=await request(f.doctor,{explanation:'Another deliberate click with equivalent scopes.'});
  assert.equal(duplicate.changed,false);assert.equal(duplicate.grant_id,allowed.body.grant_id);assert.equal(duplicate.expires_at,allowed.body.expires_at);
  time=deadline-1;assert.ok(queryPermission(f).grant);time=deadline;
  const replay=await f.patient.post(path('respond'),body,{key});assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);
  assert.equal(replay.body.expires_at,allowed.body.expires_at);assert.equal(replay.body.grant_state,'EXPIRED');assert.equal(replay.body.expires_in_seconds,0);
  assert.throws(()=>queryPermission(f),{code:'GRANT_ENDED'});assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM encounter_grants').get().n,1);
  assert.equal(f.store.db.prepare("SELECT version FROM rooms WHERE room_id='room_12'").get().version,0);
});

test('S02/S07 HTTP: pending and approved deadlines are capped by the original clinician session',async t=>{
  let time=Date.now()+1000;const f=await setup(t,{clock:{utc:()=>time,mono:()=>time}}),sessionEnd=Date.parse(f.doctor.login.body.expires_at);
  time=sessionEnd-10000;const q=await request(f.doctor);assert.equal(Date.parse(q.request_expires_at),sessionEnd);
  assert.equal(q.allowance.request.maximum_grant_seconds,10);time+=5000;
  const allowed=await f.patient.post(path('respond'),decision(q));assert.equal(allowed.status,200);assert.equal(Date.parse(allowed.body.expires_at),sessionEnd);
  assert.equal(allowed.body.expires_in_seconds,5);time=sessionEnd;
  assert.throws(()=>queryPermission(f),{code:'SESSION_ENDED'});
});

test('S08/A11 HTTP: competing decisions commit one outcome; conflicting payload and removed current permission cannot replay',async t=>{
  const f=await setup(t),q=await request(f.doctor),keys=[randomUUID(),randomUUID()],bodies=[decision(q),decision(q,'DENY')];
  const results=await Promise.all(bodies.map((body,i)=>f.patient.post(path('respond'),body,{key:keys[i]})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);const winner=results.findIndex(r=>r.status===200);
  assert.equal((await f.patient.post(path('respond'),bodies[winner],{key:keys[winner]})).body.replayed,true);
  assert.equal((await f.patient.post(path('respond'),bodies[1-winner],{key:keys[winner]})).body.error,'IDEMPOTENCY_CONFLICT');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM encounter_grants').get().n,winner===0?1:0);
  f.store.runUnit(true,()=>f.store.db.prepare("UPDATE accounts SET permissions_json='[\"patient:self\"]' WHERE account_id='account_patient_1'").run());
  assert.equal((await f.patient.post(path('respond'),bodies[winner],{key:keys[winner]})).status,403);
});

test('S08/Q09 HTTP: Allow racing with completion, transfer or logout leaves no usable old authorization',async t=>{
  for(const action of ['complete','transfer','logout']) await t.test(action,async s=>{
    const f=await setup(s),q=await request(f.doctor),key=randomUUID(),body=decision(q);
    const ending=()=>action==='complete'?f.doctor.post(`/api/v1/encounters/${encounter}/complete`,{expected_version:0}):action==='transfer'?
      f.doctor.post('/api/v1/queue/tokens/token_demo_1/transfer',{encounter_id:encounter,expected_version:0,target_room_id:'room_18',expected_target_version:0,reason:'Fictional referral'}):f.doctor.post('/api/v1/auth/logout',{});
    const [end,allow]=await Promise.all([ending(),f.patient.post(path('respond'),body,{key})]);
    assert.equal(end.status,200,end.body.error);assert.ok([200,410].includes(allow.status),allow.body.error);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM encounter_grants WHERE state='ACTIVE'").get().n,0);
    const replay=await f.patient.post(path('respond'),body,{key});
    if(replay.status===200) {assert.equal(replay.body.replayed,true);assert.ok(['ENDED','EXPIRED'].includes(replay.body.grant_state));}
    else assert.equal(replay.body.error,'CONSENT_REQUEST_ENDED');
    assert.throws(()=>queryPermission(f));
  });
});

test('S07/S08/Q10 HTTP: revocation does not change queue priority, old Allow cannot reactivate it, and completion remains available',async t=>{
  const f=await setup(t),q=await request(f.doctor),key=randomUUID(),body=decision(q),allowed=await f.patient.post(path('respond'),body,{key});
  const revoked=await f.patient.post(path('revoke'),{grant_id:allowed.body.grant_id,expected_grant_version:0,approval_channel:'PHONE'});assert.equal(revoked.status,200);
  const replay=await f.patient.post(path('respond'),body,{key});assert.equal(replay.body.grant_state,'REVOKED');assert.equal(replay.body.expires_at,allowed.body.expires_at);
  assert.equal(f.store.db.prepare("SELECT version FROM rooms WHERE room_id='room_12'").get().version,0);
  assert.equal((await f.doctor.post(`/api/v1/encounters/${encounter}/complete`,{expected_version:0})).status,200);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM clinical_events').get().n,3);
});

test('S06 HTTP: explicit versioned replacement and scope changes require a new request/choice',async t=>{
  const f=await setup(t),q=await request(f.doctor),different={explanation:'Explain additional chronological access.',scopes:['vault:read']};
  assert.equal((await f.doctor.post(path('request'),different)).status,409);
  assert.equal((await f.doctor.post(path('request'),{...different,replace_consent_request_id:q.consent_request_id})).status,422);
  assert.equal((await f.doctor.post(path('request'),{...different,replace_consent_request_id:q.consent_request_id,expected_request_version:99})).status,409);
  const replacement=await request(f.doctor,{...different,replace_consent_request_id:q.consent_request_id,expected_request_version:0});
  assert.notEqual(replacement.consent_request_id,q.consent_request_id);assert.equal((await f.patient.post(path('respond'),decision(q))).status,410);
  const allowed=await f.patient.post(path('respond'),decision(replacement));assert.equal(allowed.status,200);assert.deepEqual(allowed.body.scopes,['vault:read']);
  assert.equal((await f.doctor.post(path('request'),{explanation:'Expand again.',scopes:['vault:read','vault:query']})).status,409);
  assert.equal((await f.doctor.post(path('request'),{explanation:'Duplicate scopes.',scopes:['vault:query','vault:query']})).status,422);
});

test('S10/S11 HTTP: emergency path uses own seeded mock, durable audit, only two read scopes and current permission',async t=>{
  const f=await setup(t),route=`/api/v1/encounters/${encounter}/break-glass`,body={reason:'Fictional unconscious trauma scenario; urgent care proceeds independently.'};
  assert.equal((await f.staff.post(route,body)).status,403);
  assert.equal((await f.doctor.post(route,{reason:' '})).status,422);
  assert.equal((await f.doctor.post(route,{...body,registration_id:'MOCK-NMC-18'})).status,422);
  f.store.runUnit(true,()=>f.store.db.prepare("UPDATE accounts SET registration_id='MOCK-NMC-18' WHERE account_id='clinician_12'").run());
  assert.equal((await f.doctor.post(route,body)).status,403);
  f.store.runUnit(true,()=>f.store.db.prepare("UPDATE accounts SET registration_id='MOCK-NMC-12' WHERE account_id='clinician_12'").run());
  f.store.db.exec("CREATE TRIGGER fail_emergency BEFORE INSERT ON audit_events WHEN NEW.operation='EMERGENCY_AUTHORIZATION' BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.equal((await f.doctor.post(route,body)).body.error,'AUDIT_UNAVAILABLE');assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM encounter_grants').get().n,0);
  f.store.db.exec('DROP TRIGGER fail_emergency');
  const key=randomUUID(),allowed=await f.doctor.post(route,body,{key});assert.equal(allowed.status,200,allowed.body.error);
  assert.equal(allowed.body.registry_check,'SEEDED_MOCK_NOT_LIVE');assert.equal(allowed.body.mode,'BREAK_GLASS');assert.deepEqual(allowed.body.scopes,['triage:read','vault:query']);
  assert.equal((await f.doctor.post(route,body,{key})).body.expires_at,allowed.body.expires_at);assert.ok(queryPermission(f).grant);
  const audit=f.store.db.prepare('SELECT actor_id,operation FROM audit_events WHERE audit_id=?').get(allowed.body.authorization_event_id);
  assert.equal(audit.actor_id,'clinician_12');assert.equal(audit.operation,'EMERGENCY_AUTHORIZATION');
  assert.throws(()=>f.store.runUnit(false,()=>f.app.locals.auth.encounter(cookieReference(f.doctor.login.cookie),encounter,{scope:'summary:export'})),{code:'SCOPE_DENIED'});
  assert.ok(f.store.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE operation='EMERGENCY_REJECTED'").get().n>=4);
  f.store.runUnit(true,()=>f.store.db.prepare("UPDATE accounts SET permissions_json='[\"clinical:write\",\"queue:operate\"]' WHERE account_id='clinician_12'").run());
  assert.throws(()=>queryPermission(f),{code:'SCOPE_DENIED'});assert.equal((await f.doctor.post(route,body,{key})).status,403);
});

test('S05/S11 HTTP: consent audit failure rolls choice/grant/receipt back; no CSRF and forged fields fail safely',async t=>{
  const f=await setup(t),q=await request(f.doctor),body=decision(q),key=randomUUID();
  assert.equal((await f.patient.post(path('respond'),body,{headers:{'X-CSRF-Token':''}})).status,403);
  assert.equal((await f.patient.post(path('respond'),{...body,clinician_id:'clinician_12'})).status,422);
  f.store.db.exec("CREATE TRIGGER fail_allow BEFORE INSERT ON audit_events WHEN NEW.operation='CONSENT_RESPOND' BEGIN SELECT RAISE(ABORT,'injected'); END");
  const failed=await f.patient.post(path('respond'),body,{key});assert.equal(failed.body.error,'AUDIT_UNAVAILABLE');assert.equal(failed.body.commit_state,'NOT_APPLIED');
  assert.equal(f.store.db.prepare('SELECT state FROM consent_requests').get().state,'REQUESTED');assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM encounter_grants').get().n,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM mutation_receipts WHERE idempotency_key=?').get(key).n,0);
  f.store.db.exec('DROP TRIGGER fail_allow');assert.equal((await f.patient.post(path('respond'),body,{key})).status,200);
});

test('S05/S11 HTTP: different browser sessions need separate clinician approval; patient sees and can revoke each live grant',async t=>{
  const f=await setup(t),other=await actorClient(f,'doctor12'),key=randomUUID(),body={explanation:'Fictional session-bound request.'};
  const first=await f.doctor.post(path('request'),body,{key});assert.equal(first.status,200);
  assert.equal((await other.post(path('request'),body,{key})).body.error,'IDEMPOTENCY_CONFLICT');
  const second=await request(other,body);
  const pending=(await f.patient.get(path('status'))).body;assert.equal(pending.pending_requests.length,2);
  assert.ok(pending.pending_requests.every(row=>row.allowed_actions.includes('DENY')));
  const one=await f.patient.post(path('respond'),decision(first.body)),two=await f.patient.post(path('respond'),decision(second));
  assert.equal(one.status,200);assert.equal(two.status,200);assert.notEqual(one.body.grant_id,two.body.grant_id);
  assert.equal((await f.patient.get(path('status'))).body.active_grants.length,2);
  assert.equal((await f.doctor.post('/api/v1/auth/logout',{})).status,200);
  const remaining=(await f.patient.get(path('status'))).body.active_grants;assert.equal(remaining.length,1);assert.equal(remaining[0].grant_id,two.body.grant_id);
  assert.deepEqual(remaining[0].allowed_actions,['REVOKE']);
  assert.equal((await f.patient.post(path('revoke'),{grant_id:two.body.grant_id,expected_grant_version:0,approval_channel:'PHONE'})).status,200);
  assert.equal((await other.get(path('status'))).body.authorization_state,'LOCKED');
});

test('S10/A11 HTTP: lost emergency response remains uncertain and does not create a fabricated denial audit',async t=>{
  let once=true;const f=await setup(t,{hooks:{afterCommandCommit:()=>{if(once){once=false;throw new Error('lost response');}}}});
  const route=`/api/v1/encounters/${encounter}/break-glass`,key=randomUUID(),body={reason:'Fictional urgent trauma scenario.'};
  const lost=await f.doctor.post(route,body,{key});assert.equal(lost.body.commit_state,'UNKNOWN');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM encounter_grants WHERE state='ACTIVE'").get().n,1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE operation='EMERGENCY_REJECTED'").get().n,0);
  const replay=await f.doctor.post(route,body,{key});assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM encounter_grants').get().n,1);
});

test('Q/S step-3 HTTP journey: fictional no-phone intake, token, directions, call, check-in, assisted consent and closure',async t=>{
  const f=await setup(t);
  assert.equal((await f.doctor.post(`/api/v1/encounters/${encounter}/complete`,{expected_version:0})).status,200);
  assert.equal((await f.staff.post('/api/v1/queue/tokens/token_demo_3/withdraw',{expected_version:1,reason:'Fictional checkpoint cleanup.'})).status,200);
  const registered=await f.staff.post('/api/v1/queue/register',{room_id:'room_12',intake_mode:'MANUAL',patient:{display_name:'Fictional no-phone patient',language:'hi'}});
  assert.equal(registered.status,200);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM accounts').get().n,7);
  const directions=await f.request('/api/v1/navigation/route?origin=registration&destination=room_12&accessibility=STEP_FREE&language=hi');assert.equal(directions.body.status,'ROUTE_AVAILABLE');
  const called=await f.staff.post('/api/v1/queue/rooms/room_12/call-next',{expected_version:registered.body.room_versions.room_12});assert.equal(called.status,200);
  assert.equal(called.body.token_id,registered.body.token_id);const id=called.body.encounter_id,base=`/api/v1/encounters/${id}`;
  assert.equal((await f.staff.post(`${base}/check-in`,{expected_version:called.body.room_versions.room_12,identity_check_confirmed:true})).status,200);
  const locked=await f.staff.get(`${base}/allowance/status`);assert.equal(locked.body.authorization_state,'LOCKED');assert.equal(locked.body.clinical_data,null);
  const q=await f.doctor.post(`${base}/allowance/request`,{explanation:'इस काल्पनिक परामर्श के लिए बताए गए रिकॉर्ड साझा करें।'});assert.equal(q.status,200);
  const allowed=await f.staff.post(`${base}/allowance/respond`,decision(q.body,'ALLOW',{approval_channel:'ASSISTED_QR',assistance}));assert.equal(allowed.status,200);
  assert.equal(allowed.body.patient_id,registered.body.patient_id);
  assert.ok(f.store.runUnit(false,()=>f.app.locals.auth.encounter(cookieReference(f.doctor.login.cookie),id,{scope:'vault:query'})).grant);
  const room=(await f.staff.get('/api/v1/queue/rooms/room_12')).body;
  assert.equal((await f.doctor.post(`${base}/complete`,{expected_version:room.version})).status,200);
  assert.equal(f.store.db.prepare('SELECT state FROM encounter_grants WHERE grant_id=?').get(allowed.body.grant_id).state,'ENDED');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM clinical_events').get().n,3);
});

test.todo('S/Q browser coverage remaining: connected patient/assistant flows, real browser clearing, accessible copy and actual oral-choice verification limits');
