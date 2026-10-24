import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { actorClient, ownedDirectory, removeOwned } from './helpers.js';
import { APP_ROOT } from '../backend/config.js';
import { createApp } from '../backend/app.js';
import { clinicalFixture,ok,allow,capture,save,review,commit,commitBody,condition,initialItem,concept,encounter,patientId } from './clinical-helpers.js';
import { canonicalJSON,digest,verifyChains } from '../backend/services/vault.js';

test('ASR02/04/C12 HTTP: three independent scripted drafts, manual Unicode with zero inferred items and no history grant',async t=>{
  const f=await clinicalFixture(t);
  let version;
  for(const [fixture,reviewable,count] of [['hindi_clip_1_dyspepsia',true,1],['hindi_clip_2_bp_sugar',false,0],['hindi_clip_3_scribe',false,2]]) {
    const d=await capture(f,{input_mode:'MOCK_FIXTURE',language:'hi',fixture_id:fixture,...(version?{expected_draft_version:version}:{})});version=d.draft_version;
    assert.equal(d.draft.can_request_review,reviewable);assert.equal(d.draft.items.length,count);
    assert.equal(d.draft.mock_mode_used,true);assert.match(d.draft.simulation_label,/audio is not processed/u);assert.equal(d.draft.state,'DRAFT');
    assert.equal(d.draft.original_text,d.draft.text);
  }
  const text='काल्पनिक नोट — कोई स्वतः निदान नहीं। No medicine inferred. 5 mg ≠ 50 mg';
  const d=await capture(f,{input_mode:'MANUAL_TEXT',language:'hi',text,expected_draft_version:version});
  assert.equal(d.draft.text,text);assert.equal(d.draft.original_text,text);assert.deepEqual(d.draft.items,[]);
  assert.equal(d.draft.mock_mode_used,false);assert.equal(d.draft.simulation_label,null);assert.equal(d.draft.fixture_id,null);
  assert.equal(d.draft.can_request_review,false);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM clinical_events').get().n,3);
  assert.equal((await f.doctor.post(`/api/v1/scribe/drafts/${d.draft_id}/review`,{expected_draft_version:d.draft_version,review_confirmed:true})).body.error,'REVIEW_VALIDATION_FAILED');
});

test('ASR03/07 HTTP: strict modes, XML characters, fixture language, stale replacement and forged envelopes/warnings rejected',async t=>{
  const f=await clinicalFixture(t);
  for(const [body,error] of [
    [{input_mode:'MOCK_FIXTURE',language:'hi',fixture_id:'unknown'},'UNKNOWN_FIXTURE'],
    [{input_mode:'MOCK_FIXTURE',language:'en',fixture_id:'hindi_clip_1_dyspepsia'},'FIXTURE_LANGUAGE_MISMATCH'],
    [{input_mode:'MANUAL_TEXT',language:'en',text:'  '},'VALIDATION_ERROR'],
    [{input_mode:'MANUAL_TEXT',language:'en',text:'bad\u0000source'},'VALIDATION_ERROR'],
    [{input_mode:'MANUAL_TEXT',language:'en',text:'\ud800'},'VALIDATION_ERROR'],
    [{input_mode:'MANUAL_TEXT',language:'en',text:'fictional',fixture_id:'hindi_clip_1_dyspepsia'},'VALIDATION_ERROR'],
    [{input_mode:'MOCK_FIXTURE',language:'hi',fixture_id:'hindi_clip_1_dyspepsia',audio:'base64'},'VALIDATION_ERROR'],
    [{input_mode:'MANUAL_TEXT',language:'en',text:'fictional',expected_draft_version:1},'DRAFT_VERSION_CONFLICT'],
  ]) assert.equal((await f.doctor.post('/api/v1/scribe/transcribe',{encounter_id:encounter,...body})).body.error,error);
  const d=await capture(f);
  assert.equal((await f.doctor.post('/api/v1/scribe/transcribe',{encounter_id:encounter,input_mode:'MANUAL_TEXT',language:'en',text:'replacement'})).body.error,'DRAFT_VERSION_CONFLICT');
  for(const extra of [{warnings:[]},{recorded_by:'clinician_18'},{reviewed_payload_hash:'a'.repeat(64)}]) {
    assert.equal((await f.doctor.post(`/api/v1/scribe/drafts/${d.draft_id}/save`,{expected_draft_version:1,text:d.draft.text,items:d.draft.items,...extra})).status,422);
  }
  assert.equal(f.app.locals.capture.inFlight,0);
  assert.equal((await f.request('/api/v1/scribe/dictate',{method:'POST',body:{}})).status,404);
  assert.equal((await f.doctor.post('/api/v1/vault/events',{})).status,404);
});

test('ASR07/08 HTTP: exact source/hash, save invalidates review, stale capture/review replay returns metadata without later edits',async t=>{
  const f=await clinicalFixture(t),key=randomUUID(),body={encounter_id:encounter,input_mode:'MOCK_FIXTURE',language:'hi',fixture_id:'hindi_clip_1_dyspepsia'};
  const d=ok(await f.doctor.post('/api/v1/scribe/transcribe',body,{key}));
  const replay=ok(await f.doctor.post('/api/v1/scribe/transcribe',body,{key}));assert.equal(replay.replayed,true);assert.deepEqual(replay.draft.items,d.draft.items);
  const r=await review(f,d),row=f.store.db.prepare('SELECT * FROM clinical_drafts').get();
  assert.equal(r.reviewed_payload_hash,digest(row.capture_json));assert.equal(r.draft.reviewed_by,'clinician_12');assert.equal(row.version,2);
  const s=await save(f,r,r.draft.items,`${r.draft.text} Clinician retained source and edited this fictional note.`);
  assert.equal(s.draft.state,'DRAFT');assert.equal(s.draft.reviewed_payload_hash,null);assert.equal(s.draft.original_text,d.draft.original_text);assert.equal(s.draft.edited,true);
  const stale=ok(await f.doctor.post('/api/v1/scribe/transcribe',body,{key}));
  assert.equal(stale.snapshot_available,false);assert.equal(stale.draft,null);assert.equal(stale.draft_version,1);assert.equal(stale.current_draft_version,3);
  assert.equal((await f.doctor.post('/api/v1/scribe/commit',commitBody(r))).body.error,'DRAFT_VERSION_CONFLICT');
  const final=await commit(f,await review(f,s));assert.equal(final.state,'COMMITTED');
  const event=JSON.parse(f.store.db.prepare('SELECT event_json FROM clinical_events WHERE event_id=?').get(final.event_ids[0]).event_json);
  assert.equal(event.recorded_by,'clinician_12');assert.equal(event.review.status,'CLINICIAN_REVIEWED');assert.equal(event.capture.method,'MOCK_ASR');assert.equal(event.capture.confidence,null);
  assert.equal(event.source.quote,d.draft.items[0].source.quote);assert.equal(event.payload.verification_status,'UNCONFIRMED');
  assert.equal((await f.doctor.post(`/api/v1/scribe/drafts/${s.draft_id}/review`,{expected_draft_version:final.draft_version,review_confirmed:true})).status,409);
});

test('C01/02/09/11 HTTP: complete typed items, actual negative identity, report provenance and missing fields at review',async t=>{
  const f=await clinicalFixture(t);let d=await capture(f,{input_mode:'MANUAL_TEXT',language:'en',text:'Fictional assessment and report.'});
  const rx=initialItem('MEDICATION_RECORDED',{concept:concept('Metformin','metformin_demo'),statement_kind:'PRESCRIBED',status:'ACTIVE',dose_text:null,route_text:null,frequency_text:null,duration_text:null,reason:null});
  d=await save(f,d,[rx]);assert.equal(d.draft.can_request_review,false);
  const incomplete=await f.doctor.post(`/api/v1/scribe/drafts/${d.draft_id}/review`,{expected_draft_version:d.draft_version,review_confirmed:true});
  assert.equal(incomplete.status,422);assert.equal(incomplete.body.error,'REVIEW_VALIDATION_FAILED');assert.ok(!incomplete.text.includes('Metformin'));
  rx.payload.dose_text='fictional dose';rx.payload.route_text='oral';rx.payload.frequency_text='fictional frequency';
  const negative=initialItem('NEGATIVE_FINDING_RECORDED',{scope:{topic_key:'MENTAL_HEALTH_HISTORY',timeframe:'AT_ASSESSMENT'},declared_by:'forged_actor',declared_on:'2026-01-01',clinical_basis:'Fictional assessment only',scope_text:'Dated limited assessment'}, {occurred_on:'2026-01-01'});
  const report=condition('Renal impairment','renal_impairment_demo');report.source.kind='PATIENT_REPORT';report.payload.verification_status='CONFIRMED';
  d=await save(f,d,[rx,negative,report]);assert.equal(d.draft.items[1].payload.declared_by,'clinician_12');assert.equal(d.draft.can_request_review,false);
  report.payload.verification_status='UNCONFIRMED';
  const procedure=initialItem('PROCEDURE_RECORDED',{concept:concept('Cholecystectomy','cholecystectomy_demo'),status:'REPORTED_COMPLETED',note:null},{occurrence_text:'Aug 2021'});
  const allergy=initialItem('ALLERGY_RECORDED',{concept:concept('Latex','latex_demo'),clinical_status:'UNKNOWN',verification_status:'UNCONFIRMED',reaction_text:null,reaction_severity:'UNKNOWN'});
  d=await save(f,d,[rx,negative,report,procedure,allergy]);const c=await commit(f,await review(f,d));
  assert.equal(c.event_ids.length,5);assert.equal(c.last_sequence-c.first_sequence,4);assert.equal(verifyChains(f.store.db).find(v=>v.patient_id===patientId).checked_events,7);
  const event=JSON.parse(f.store.db.prepare('SELECT event_json FROM clinical_events WHERE event_id=?').get(c.event_ids[3]).event_json);
  assert.equal(event.occurred_on,null);assert.equal(event.occurrence_text,'Aug 2021');assert.equal(event.capture.method,'MANUAL');assert.equal(event.capture.extractor_version,null);
});

test('C05/ASR09 HTTP: concurrent saves/commits, lost commit response, audit rollback and closure-safe original replay',async t=>{
  let lose=false;
  const f=await clinicalFixture(t,{hooks:{afterCommandCommit(){if(lose){lose=false;throw new Error('lost');}}}});
  const d=await capture(f),saveBody={expected_draft_version:1,text:d.draft.text,items:d.draft.items};
  const saves=await Promise.all([f.doctor.post(`/api/v1/scribe/drafts/${d.draft_id}/save`,saveBody),f.doctor.post(`/api/v1/scribe/drafts/${d.draft_id}/save`,saveBody)]);
  assert.deepEqual(saves.map(r=>r.status).sort(),[200,409]);const s=ok(saves.find(r=>r.status===200)),r=await review(f,s),body=commitBody(r),key=randomUUID();
  f.store.db.exec("CREATE TRIGGER fail_commit_audit BEFORE INSERT ON audit_events WHEN NEW.operation='SCRIBE_COMMIT' BEGIN SELECT RAISE(ABORT,'test'); END");
  const failed=await f.doctor.post('/api/v1/scribe/commit',body,{key});assert.equal(failed.body.error,'AUDIT_UNAVAILABLE');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM clinical_events').get().n,3);assert.equal(f.store.db.prepare('SELECT state FROM clinical_drafts').get().state,'REVIEWED');
  f.store.db.exec('DROP TRIGGER fail_commit_audit');
  f.store.db.exec("CREATE TRIGGER fail_commit_receipt BEFORE INSERT ON mutation_receipts WHEN NEW.operation='POST /api/v1/scribe/commit' BEGIN SELECT RAISE(ABORT,'test'); END");
  const noReceipt=await f.doctor.post('/api/v1/scribe/commit',body,{key});assert.equal(noReceipt.body.commit_state,'NOT_APPLIED');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM clinical_events').get().n,3);assert.equal(f.store.db.prepare('SELECT state FROM clinical_drafts').get().state,'REVIEWED');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE operation='SCRIBE_COMMIT'").get().n,0);
  f.store.db.exec('DROP TRIGGER fail_commit_receipt');lose=true;
  const unknown=await f.doctor.post('/api/v1/scribe/commit',body,{key});assert.equal(unknown.body.commit_state,'UNKNOWN');
  const c=ok(await f.doctor.post('/api/v1/scribe/commit',body,{key}));assert.equal(c.replayed,true);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM clinical_events').get().n,4);
  const room=ok(await f.doctor.get('/api/v1/queue/rooms/room_12'));ok(await f.doctor.post(`/api/v1/encounters/${encounter}/complete`,{expected_version:room.version}));
  assert.deepEqual(ok(await f.doctor.post('/api/v1/scribe/commit',body,{key})).event_ids,c.event_ids);
  assert.equal((await f.doctor.post('/api/v1/scribe/commit',body)).status,409);
  const receipt=JSON.parse(f.store.db.prepare("SELECT outcome_json FROM mutation_receipts WHERE operation='POST /api/v1/scribe/commit'").get().outcome_json);
  assert.ok(!canonicalJSON(receipt).includes('Dyspepsia'));assert.deepEqual(receipt.event_ids,c.event_ids);
});

test('S/C/ASR permissions HTTP: patients/staff/other doctor cannot read drafts; closure and revoked assignment prevent disclosure',async t=>{
  const f=await clinicalFixture(t),other=await actorClient(f,'doctor18'),d=await capture(f);
  for(const actor of [f.patient,f.staff,other]) {
    assert.equal((await actor.get(`/api/v1/encounters/${encounter}/draft`)).status,404);
    assert.notEqual((await actor.post(`/api/v1/scribe/drafts/${d.draft_id}/review`,{expected_draft_version:1,review_confirmed:true})).status,200);
  }
  f.store.db.prepare("UPDATE accounts SET permissions_json='[\"queue:operate\",\"emergency:read\"]' WHERE account_id='clinician_12'").run();
  assert.equal((await f.doctor.get(`/api/v1/encounters/${encounter}/draft`)).status,403);
});

test('ASR01 HTTP: false/invalid/missing/corrupt fixtures preserve healthy manual capture and queue',async t=>{
  for(const value of ['false','invalid']) await t.test(`USE_MOCK_ASR=${value}`,async t=>{
    const f=await clinicalFixture(t,{serverEnv:{USE_MOCK_ASR:value}});
    assert.equal((await f.doctor.post('/api/v1/scribe/transcribe',{encounter_id:encounter,input_mode:'MOCK_FIXTURE',language:'hi',fixture_id:'hindi_clip_1_dyspepsia'})).body.error,'ASR_MODE_UNAVAILABLE');
    assert.equal((await capture(f,{input_mode:'MANUAL_TEXT',language:'en',text:'Fictional manual fallback.'})).draft.mock_mode_used,false);
    assert.equal((await f.staff.get('/api/v1/queue/rooms/room_12')).status,200);
  });
  for(const source of [null,'{"fixtures":[],"fixtures":[]}']) await t.test(source===null?'missing registry':'duplicate registry',async t=>{
    const dir=await ownedDirectory();t.after(()=>removeOwned(dir));
    await copyFile(path.join(APP_ROOT,'data/fixtures/facility_map.json'),path.join(dir,'facility_map.json'));
    if(source) await writeFile(path.join(dir,'mock_asr_outputs.json'),source);
    const f=await clinicalFixture(t,{fixtureDirectory:dir});
    const result=await f.doctor.post('/api/v1/scribe/transcribe',{encounter_id:encounter,input_mode:'MOCK_FIXTURE',language:'hi',fixture_id:'hindi_clip_1_dyspepsia'});
    assert.equal(result.body.error,'ASR_MODE_UNAVAILABLE');assert.equal(result.body.retry_strategy,'NONE');
    assert.equal((await capture(f,{input_mode:'MANUAL_TEXT',language:'en',text:'Fictional manual fallback.'})).draft.state,'DRAFT');
  });
});

test('ASR09/10 HTTP: ten admitted captures, immediate eleventh rejection, aborted work retains permit and every path releases', {timeout:15000},async t=>{
  let entered=0,allEntered,proceed;const ready=new Promise(resolve=>{allEntered=resolve;});const gate=new Promise(resolve=>{proceed=resolve;});
  const f=await clinicalFixture(t,{hooks:{beforeCapture(){entered+=1;if(entered===10) allEntered();return gate;}}});
  const body={encounter_id:encounter,input_mode:'MOCK_FIXTURE',language:'hi',fixture_id:'hindi_clip_1_dyspepsia'};
  const abandoned=new AbortController();
  const abandonedResult=fetch(`${f.base}/api/v1/scribe/transcribe`,{method:'POST',signal:abandoned.signal,
    headers:{Origin:f.origin,'Content-Type':'application/json','X-Idempotency-Key':randomUUID(),'X-CSRF-Token':f.doctor.login.body.csrf_token,Cookie:f.doctor.login.cookie},
    body:JSON.stringify(body)}).then(r=>r.text()).catch(error=>error.name);
  const active=Array.from({length:9},()=>f.doctor.post('/api/v1/scribe/transcribe',body));
  try {
    await ready;assert.equal(f.app.locals.capture.inFlight,10);
    const full=await f.doctor.post('/api/v1/scribe/transcribe',body);assert.equal(full.status,429);assert.equal(full.body.error,'INGESTION_BUSY');assert.equal(full.headers.get('Retry-After'),'1');
    assert.equal((await f.staff.get('/api/v1/queue/rooms/room_12')).status,200);
    abandoned.abort();assert.equal(await abandonedResult,'AbortError');await delay(20);assert.equal(f.app.locals.capture.inFlight,10);
  } finally {proceed();await Promise.all(active);}
  assert.equal(f.app.locals.capture.inFlight,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM clinical_drafts').get().n,1);
  assert.equal(f.store.db.prepare('SELECT version FROM clinical_drafts').get().version,1);
});

test('ASR08/09 HTTP: delayed capture metadata never attaches newer saved content; late close denies draft delivery',async t=>{
  let after=null;
  const f=await clinicalFixture(t,{hooks:{async afterCommandCommit(){if(after){const fn=after;after=null;await fn();}}}});
  after=async()=>{
    const row=f.store.db.prepare('SELECT * FROM clinical_drafts').get(),value=JSON.parse(row.capture_json);
    ok(await f.doctor.post(`/api/v1/scribe/drafts/${row.draft_id}/save`,{expected_draft_version:1,text:`${value.text} Later saved edit.`,items:value.items}));
  };
  const d=await capture(f);assert.equal(d.snapshot_available,false);assert.equal(d.draft,null);assert.equal(d.current_draft_version,2);
  assert.match(ok(await f.doctor.get(`/api/v1/encounters/${encounter}/draft`)).draft.text,/Later saved edit/u);
  after=async()=>{const room=ok(await f.doctor.get('/api/v1/queue/rooms/room_12'));ok(await f.doctor.post(`/api/v1/encounters/${encounter}/complete`,{expected_version:room.version}));};
  const lost=await f.doctor.post('/api/v1/scribe/transcribe',{encounter_id:encounter,input_mode:'MANUAL_TEXT',language:'en',text:'Fictional source before closure.',expected_draft_version:2});
  assert.equal(lost.status,409);assert.equal(lost.body.commit_state,'UNKNOWN');assert.equal(lost.body.draft,undefined);
  assert.equal(f.store.db.prepare('SELECT state,version FROM clinical_drafts').get().version,3);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM clinical_events').get().n,3);
});

test('D/ASR HTTP: saved review survives real close/reopen with original session/hash; one final batch persists',async t=>{
  const f=await clinicalFixture(t),d=await review(f,await capture(f));
  await f.cleanup();
  const app=await createApp(f.settings),server=http.createServer(app);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const response=await fetch(`${base}/api/v1/encounters/${encounter}/draft`,{headers:{Cookie:f.doctor.login.cookie}});
    assert.equal(response.status,200);const current=await response.json();assert.equal(current.draft.reviewed_payload_hash,d.reviewed_payload_hash);assert.equal(current.draft.state,'REVIEWED');
    const result=await fetch(`${base}/api/v1/scribe/commit`,{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json',
      'X-Idempotency-Key':randomUUID(),'X-CSRF-Token':f.doctor.login.body.csrf_token,Cookie:f.doctor.login.cookie},body:JSON.stringify(commitBody(d))});
    assert.equal(result.status,200);assert.equal((await result.json()).event_ids.length,1);
    assert.equal(verifyChains(app.locals.store.db).find(v=>v.patient_id===patientId).checked_events,3);
  } finally {await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});app.locals.close();}
});
