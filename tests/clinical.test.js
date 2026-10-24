import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { actorClient } from './helpers.js';
import { clinicalFixture,ok,allow,capture,save,review,commit,commitBody,condition,initialItem,concept,encounter,patientId,queryBody,nextEncounter } from './clinical-helpers.js';
import { supportedQuestions,verifyChains } from '../backend/services/vault.js';

const state=(f,patient=patientId)=>`/api/v1/vault/patient/${patient}/active-state?encounter_id=${f.encounter}`;
const history=(f,extra='')=>`/api/v1/vault/patient/${patientId}/events?encounter_id=${f.encounter}${extra}`;
const ask=async(f,question='Penicillin allergy history?',extra={})=>f.doctor.post('/api/v1/vault/query',queryBody(f,question),extra);
const correction=(event,extra={})=>({event_type:event.event_type,entity_id:event.entity_id,change_kind:'CORRECTION',
  change_reason:'Correct fictional source entry',supersedes_event_id:event.event_id,occurred_on:event.occurred_on,
  occurrence_text:event.occurrence_text,source:{...event.source,quote:null},payload:structuredClone(event.payload),...extra});

test('C08/A HTTP: locked differs from empty, positive/stopped/negative/missing evidence retains real citations and six topics',async t=>{
  const f=await clinicalFixture(t);
  assert.deepEqual(ok(await f.doctor.get(state(f))).clinical_data,null);
  assert.equal((await ask(f)).body.error,'HISTORY_LOCKED');
  const other=await actorClient(f,'doctor18');assert.equal((await other.get(state(f))).status,404);
  await allow(f);
  const projection=ok(await f.doctor.get(state(f)));assert.equal(projection.projection_status,'COMPLETE');
  assert.equal(projection.clinical_data.medications[0].payload.status,'DISCONTINUED');
  assert.equal(projection.clinical_data.allergies[0].payload.concept.term_key,'penicillin_demo');
  for(const [question,certainty] of [[supportedQuestions[0],'VERIFIED_POSITIVE'],[supportedQuestions[1],'VERIFIED_POSITIVE'],
    [supportedQuestions[3],'NOT_RECORDED_IN_VAULT'],[supportedQuestions[4],'NOT_RECORDED_IN_VAULT'],[supportedQuestions[5],'NOT_RECORDED_IN_VAULT']]) {
    const a=ok(await ask(f,question));assert.equal(a.certainty_state,certainty);assert.equal(a.lookup_status,'COMPLETE');assert.equal(a.as_of_sequence,2);
    if(certainty==='VERIFIED_POSITIVE') {
      assert.equal(a.source_citations.length,1);assert.equal(a.source_citations[0].review_status,'FIXTURE_NOT_CLINICALLY_VALIDATED');assert.equal(a.source_citations[0].synthetic,true);
    } else assert.deepEqual(a.source_citations,[]);
  }
  const doctor18=await actorClient(f,'doctor18'),patientB=await actorClient(f,'patient-b');
  const b={...f,doctor:doctor18,patient:patientB,encounter:'encounter_demo_negative'};await allow(b);
  const neg=ok(await doctor18.post('/api/v1/vault/query',{patient_id:'patient_demo_negative',encounter_id:b.encounter,question_text:supportedQuestions[2]}));
  assert.equal(neg.certainty_state,'DOCUMENTED_NEGATIVE');assert.equal(neg.documented_negative_detail.scope.topic_key,'LATEX_ALLERGY');
  assert.equal(neg.documented_negative_detail.declared_on,neg.source_citations[0].occurred_on);
  assert.match(neg.answer_text,/does not establish current clinical absence or safety/u);
});

test('C10 HTTP: exact aliases only; negated/compound/generic input and forged scope shortcuts cannot create missing-record answers',async t=>{
  const f=await clinicalFixture(t);await allow(f);
  for(const question of ['No penicillin allergy?', 'Penicillin allergy history and renal impairment?', 'BP medicine?', 'all clear?', 'father has sugar']) {
    const a=await ask(f,question);assert.equal(a.status,422);assert.equal(a.body.error,'UNSUPPORTED_QUESTION');assert.equal(a.body.certainty_state,undefined);
  }
  assert.equal(ok(await ask(f,'  Ｐｅｎｉｃｉｌｌｉｎ   allergy history ? ')).topic_key,'PENICILLIN_ALLERGY');
  assert.equal((await f.doctor.post('/api/v1/vault/query',{...queryBody(f),mode:'EMERGENCY'})).status,422);
  assert.equal((await f.doctor.post('/api/v1/vault/query',{...queryBody(f),patient_id:'patient_demo_negative'})).status,404);
});

test('C03/05/06/12 HTTP: current permitted correction, old as-of replay, subsequent retraction and terminal thread',async t=>{
  let f=await clinicalFixture(t);
  const original=JSON.parse(f.store.db.prepare("SELECT event_json FROM clinical_events WHERE json_extract(event_json,'$.event_type')='ALLERGY_RECORDED'").get().event_json);
  let d=await capture(f,{input_mode:'MANUAL_TEXT',language:'en',text:'Fictional correction based on the actual prior source.'});
  const item=correction(original);item.payload.reaction_text='Corrected fictional source reaction';
  assert.equal((await f.doctor.post(`/api/v1/scribe/drafts/${d.draft_id}/save`,{expected_draft_version:d.draft_version,text:d.draft.text,items:[item]})).status,404);
  await allow(f);
  const key=randomUUID(),before=ok(await ask(f,undefined,{key}));
  d=await save(f,d,[item]);const c=await commit(f,await review(f,d));
  assert.equal(c.first_sequence,3);assert.equal(f.store.db.prepare('SELECT event_json FROM clinical_events WHERE event_id=?').get(original.event_id).event_json.includes('Corrected fictional'),false);
  const after=ok(await ask(f));assert.equal(after.source_citations[0].event_id,c.event_ids[0]);
  const replay=ok(await ask(f,undefined,{key}));assert.equal(replay.replayed,true);assert.equal(replay.as_of_sequence,before.as_of_sequence);assert.deepEqual(replay.source_citations,before.source_citations);assert.equal(replay.query_id,before.query_id);
  assert.equal(ok(await f.doctor.get(history(f,'&as_of_sequence=2'))).events.length,2);
  const current=JSON.parse(f.store.db.prepare('SELECT event_json FROM clinical_events WHERE event_id=?').get(c.event_ids[0]).event_json);
  f=await nextEncounter(f);await allow(f);
  let n=await capture(f,{input_mode:'MANUAL_TEXT',language:'en',text:'Fictional withdrawal of erroneous source evidence.'});
  const retract=correction(current,{event_type:'RECORD_RETRACTED',change_kind:'RETRACTION',change_reason:'Fictional source entered in error',payload:{reason:'Fictional source entered in error'}});
  n=await save(f,n,[retract]);const retracted=await commit(f,await review(f,n));assert.equal(retracted.event_ids.length,1);
  assert.equal(ok(await ask(f)).certainty_state,'NOT_RECORDED_IN_VAULT');
  const events=ok(await f.doctor.get(history(f)));assert.equal(events.events.length,4);assert.equal(events.events.at(-1).event.event_type,'RECORD_RETRACTED');
  f=await nextEncounter(f);await allow(f);n=await capture(f,{input_mode:'MANUAL_TEXT',language:'en',text:'Attempted fictional revival.'});
  const old=await f.doctor.post(`/api/v1/scribe/drafts/${n.draft_id}/save`,{expected_draft_version:1,text:n.draft.text,items:[correction(current)]});
  assert.equal(old.body.error,'STATE_VERSION_CONFLICT');assert.equal(verifyChains(f.store.db).find(v=>v.patient_id===patientId).checked_events,4);
});

test('C03/09/10 HTTP: same-name separate entities, positive/negative conflict, incomplete vocabulary and no date winner',async t=>{
  const f=await clinicalFixture(t);await allow(f);let d=await capture(f,{input_mode:'MANUAL_TEXT',language:'en',text:'Fictional unrelated courses and distinct assessment.'});
  const medication=()=>initialItem('MEDICATION_RECORDED',{concept:concept('Ecosprin','ecosprin_demo'),statement_kind:'REPORTED_TAKING',status:'UNKNOWN',
    dose_text:null,route_text:null,frequency_text:null,duration_text:null,reason:null});
  const negative=initialItem('NEGATIVE_FINDING_RECORDED',{scope:{topic_key:'PENICILLIN_ALLERGY',timeframe:'AT_ASSESSMENT'},declared_by:null,
    declared_on:'2026-03-15',clinical_basis:'Fictional limited assessment',scope_text:'Negative only at this assessment'},{occurred_on:'2026-03-15'});
  const unknown=initialItem('ALLERGY_RECORDED',{concept:concept('Unmapped fictional substance'),clinical_status:'UNKNOWN',verification_status:'UNCONFIRMED',reaction_text:null,reaction_severity:'UNKNOWN'});
  // First establish a coherent conflict; an unmapped condition makes renal lookup incomplete independently.
  d=await save(f,d,[medication(),medication(),negative,condition('Unmapped fictional condition',null)]);await commit(f,await review(f,d));
  const stateBody=ok(await f.doctor.get(state(f)));assert.equal(stateBody.clinical_data.medications.length,3);
  assert.notEqual(stateBody.clinical_data.medications[1].entity_id,stateBody.clinical_data.medications[2].entity_id);
  const conflict=ok(await ask(f));assert.equal(conflict.lookup_status,'CONFLICT');assert.equal(conflict.certainty_state,null);assert.equal(conflict.source_citations.length,2);
  assert.equal(conflict.documented_negative_detail,undefined);
  const gap=ok(await ask(f,supportedQuestions[3]));assert.equal(gap.lookup_status,'INCOMPLETE');assert.equal(gap.certainty_state,null);assert.equal(gap.coverage.unmapped_event_ids.length,1);
  assert.equal(unknown.payload.concept.term_key,null);
});

test('C04 HTTP: wrong patient/entity/family, arbitrary initial IDs and same-thread duplicate batch fail without changes',async t=>{
  const f=await clinicalFixture(t);await allow(f);
  const event=JSON.parse(f.store.db.prepare("SELECT event_json FROM clinical_events WHERE event_id='evt_demo_stop'").get().event_json);
  let d=await capture(f,{input_mode:'MANUAL_TEXT',language:'en',text:'Fictional target checks.'});
  for(const items of [
    [correction(event,{entity_id:'some_other_entity'})],
    [correction(event,{event_type:'CONDITION_RECORDED',payload:condition().payload})],
    [correction(event,{supersedes_event_id:'evt_demo_latex_negative'})],
    [condition('Dyspepsia','dyspepsia_demo'),{...condition(),entity_id:event.entity_id}],
    [correction(event),correction(event)],
  ]) {
    const result=await f.doctor.post(`/api/v1/scribe/drafts/${d.draft_id}/save`,{expected_draft_version:1,text:d.draft.text,items});
    assert.ok([404,409].includes(result.status),JSON.stringify(result.body));
  }
  assert.equal(f.store.db.prepare('SELECT version FROM clinical_drafts').get().version,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM clinical_events').get().n,3);
});

test('S/C HTTP: own-patient pagination and integrity after closure, scope distinctions and audit failures withhold clinical bytes',async t=>{
  const f=await clinicalFixture(t);await allow(f,['triage:read','vault:query']);
  assert.equal((await f.doctor.get(history(f))).body.error,'SCOPE_DENIED');
  const first=ok(await f.patient.get(`/api/v1/vault/patient/${patientId}/events?limit=1`));assert.equal(first.events.length,1);assert.equal(first.next_after_sequence,1);assert.equal(first.as_of_sequence,2);
  assert.equal(ok(await f.patient.get(`/api/v1/vault/patient/${patientId}/events?limit=1&after_sequence=1&as_of_sequence=2`)).next_after_sequence,null);
  assert.equal((await f.patient.get('/api/v1/vault/patient/patient_demo_negative/events')).status,404);
  assert.equal((await f.patient.get(`/api/v1/vault/patient/${patientId}/events?limit=101`)).status,422);
  const room=ok(await f.doctor.get('/api/v1/queue/rooms/room_12'));ok(await f.doctor.post(`/api/v1/encounters/${encounter}/complete`,{expected_version:room.version}));
  const integrity=ok(await f.patient.get(`/api/v1/audit/integrity-check/${patientId}`));assert.equal(integrity.integrity_status,'VALID');assert.equal(integrity.checked_events,2);assert.match(integrity.head_hash,/^[a-f0-9]{64}$/u);
  f.store.db.exec("CREATE TRIGGER fail_read_audit BEFORE INSERT ON audit_events WHEN NEW.operation='CLINICAL_EVENTS' BEGIN SELECT RAISE(ABORT,'test'); END");
  const failed=await f.patient.get(`/api/v1/vault/patient/${patientId}/events`);assert.equal(failed.body.error,'AUDIT_UNAVAILABLE');assert.ok(!failed.text.includes('Ecosprin'));
});

test('C14 HTTP: optional checks disclose unsupported coverage, require normal scope and never gate independent commit',async t=>{
  const f=await clinicalFixture(t),body={patient_id:patientId,encounter_id:encounter,intervention_type:'MEDICATION',planned_items:['Fictional planned medication']};
  assert.equal((await f.doctor.post('/api/v1/vault/affirmation',body)).body.error,'HISTORY_LOCKED');
  await allow(f);const a=ok(await f.doctor.post('/api/v1/vault/affirmation',body));
  assert.equal(a.evaluation_status,'NOT_EVALUATED');assert.equal(a.doctor_action_required,false);assert.deepEqual(a.findings,[]);
  assert.match(a.unsupported_areas[0],/No sourced/u);assert.equal(a.source_citations.length,2);assert.ok(!JSON.stringify(a).includes('AFFIRMED_SAFE'));
  const d=await capture(f);assert.equal((await commit(f,await review(f,d))).event_ids.length,1);
});

test('S/C release HTTP: revocation during compute withholds entire answer and old receipts remain authorization guarded',async t=>{
  let gate=null;
  const f=await clinicalFixture(t,{hooks:{async beforeProtectedRelease(){if(gate){const selected=gate;gate=null;await selected();}}}});
  const grant=await allow(f),key=randomUUID();ok(await ask(f,undefined,{key}));
  gate=async()=>{ok(await f.patient.post(`/api/v1/encounters/${encounter}/allowance/revoke`,{grant_id:grant.grant_id,expected_grant_version:0,approval_channel:'PHONE'}));};
  const denied=await ask(f);assert.equal(denied.body.error,'GRANT_ENDED');assert.ok(!denied.text.includes('Penicillin'));assert.equal(denied.body.certainty_state,undefined);
  assert.equal((await ask(f,undefined,{key})).body.error,'GRANT_ENDED');
  assert.equal(ok(await f.doctor.get(state(f))).authorization_state,'LOCKED');
});

test('C05 HTTP: simultaneous identical query/commit intents share one receipt and one clinical batch',async t=>{
  const f=await clinicalFixture(t);await allow(f);const key=randomUUID();
  const queries=await Promise.all([ask(f,undefined,{key}),ask(f,undefined,{key})]);
  const [a,b]=queries.map(ok);assert.equal(a.query_id,b.query_id);assert.equal(a.as_of_sequence,b.as_of_sequence);
  const d=await review(f,await capture(f)),commitKey=randomUUID();
  const results=await Promise.all([f.doctor.post('/api/v1/scribe/commit',commitBody(d),{key:commitKey}),f.doctor.post('/api/v1/scribe/commit',commitBody(d),{key:commitKey})]);
  assert.deepEqual(results.map(ok).map(v=>v.event_ids),[results[0].body.event_ids,results[0].body.event_ids]);
  assert.deepEqual(results.map(r=>r.body.replayed).sort(),[false,true]);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM clinical_events').get().n,4);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM mutation_receipts WHERE operation='POST /api/v1/vault/query'").get().n,1);
});

test('C07/S HTTP: runtime canonical tampering returns a safe integrity error without partial facts',async t=>{
  const f=await clinicalFixture(t);await allow(f);
  // Deliberately damage only this disposable file through a privileged test connection.
  f.store.db.exec('DROP TRIGGER clinical_no_update');
  f.store.db.prepare("UPDATE clinical_events SET event_json=json_set(event_json,'$.source.original_author','Altered fictional source') WHERE event_id='evt_demo_stop'").run();
  const result=await ask(f);assert.equal(result.body.error,'CLINICAL_INTEGRITY_INVALID');assert.equal(result.status,503);
  assert.equal(result.body.certainty_state,undefined);assert.ok(!result.text.includes('Altered fictional source'));
  const failed=ok(await f.patient.get(`/api/v1/audit/integrity-check/${patientId}`));
  assert.equal(failed.status,'FAIL');assert.equal(failed.first_failure_sequence,1);
});

test('C12/S HTTP: exact grant deadline and emergency scopes guard actual clinical endpoints; new care remains independent',async t=>{
  let time=Date.now()+60000;const f=await clinicalFixture(t,{clock:{utc:()=>time,mono:()=>time}});const grant=await allow(f),key=randomUUID();
  ok(await ask(f,undefined,{key}));time=Date.parse(grant.expires_at);
  assert.equal((await ask(f,undefined,{key})).body.error,'GRANT_ENDED');
  const emergency=ok(await f.doctor.post(`/api/v1/encounters/${encounter}/break-glass`,{reason:'Fictional urgent consultation review.'}));
  assert.equal(emergency.mode,'BREAK_GLASS');assert.equal((await ask(f)).status,200);
  assert.equal((await f.doctor.get(history(f))).body.error,'SCOPE_DENIED');
  assert.equal((await f.doctor.post('/api/v1/vault/affirmation',{patient_id:patientId,encounter_id:encounter,intervention_type:'PROCEDURE',planned_items:['Fictional procedure']})).body.error,'SCOPE_DENIED');
  const d=await capture(f);await commit(f,await review(f,d));
});

test('Q/S/C HTTP journey: no-phone intake through navigation, assisted Deny and reviewed new care without opening prior history',async t=>{
  const f=await clinicalFixture(t),staff=f.staff,doctor=await actorClient(f,'doctor18');
  const intake=ok(await staff.post('/api/v1/queue/register',{room_id:'room_18',intake_mode:'MANUAL',patient:{display_name:'Fictional no-phone patient',language:'hi'}}));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM accounts WHERE patient_id=?').get(intake.patient_id).n,0);
  assert.equal((await staff.get('/api/v1/navigation/route?origin=registration&destination=room_18&accessibility=STEP_FREE&language=hi')).body.status,'ROUTE_AVAILABLE');
  let room=ok(await doctor.get('/api/v1/queue/rooms/room_18'));
  ok(await doctor.post('/api/v1/encounters/encounter_demo_negative/complete',{expected_version:room.version}));
  room=ok(await doctor.get('/api/v1/queue/rooms/room_18'));
  const call=ok(await doctor.post('/api/v1/queue/rooms/room_18/call-next',{expected_version:room.version}));
  room=ok(await doctor.get('/api/v1/queue/rooms/room_18'));
  ok(await doctor.post(`/api/v1/encounters/${call.encounter_id}/check-in`,{expected_version:room.version,identity_check_confirmed:true}));
  const q=ok(await doctor.post(`/api/v1/encounters/${call.encounter_id}/allowance/request`,{explanation:'Fictional history request; new care remains available if declined.'}));
  ok(await staff.post(`/api/v1/encounters/${call.encounter_id}/allowance/respond`,{consent_request_id:q.consent_request_id,
    expected_request_version:0,action:'DENY',approval_channel:'ASSISTED_QR',assistance:{patient_present:true,identity_check_confirmed:true,patient_choice_confirmed:true}}));
  const care={...f,doctor,encounter:call.encounter_id};
  const d=await capture(care),c=await commit(care,await review(care,d));assert.equal(c.patient_id,intake.patient_id);assert.equal(c.first_sequence,1);
  const locked=ok(await doctor.get(`/api/v1/vault/patient/${intake.patient_id}/active-state?encounter_id=${call.encounter_id}`));
  assert.equal(locked.authorization_state,'LOCKED');assert.equal(locked.clinical_data,null);
  const event=JSON.parse(f.store.db.prepare('SELECT event_json FROM clinical_events WHERE event_id=?').get(c.event_ids[0]).event_json);
  assert.equal(event.review.reviewed_by,'clinician_18');assert.equal(event.encounter_id,call.encounter_id);
  room=ok(await doctor.get('/api/v1/queue/rooms/room_18'));ok(await doctor.post(`/api/v1/encounters/${call.encounter_id}/complete`,{expected_version:room.version}));
});
