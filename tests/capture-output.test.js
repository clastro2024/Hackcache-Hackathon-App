import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import nodePath from 'node:path';
import { actorClient } from './helpers.js';
import { clinicalFixture,ok,allow,capture,save,review,commit,condition,initialItem,concept,encounter,patientId,nextEncounter } from './clinical-helpers.js';
import { boundedOutput,OUTPUT_LIMIT,preflightFHIR } from '../backend/services/output.js';
import { backupDatabase,restoreDatabase } from '../backend/manage.js';
import { createApp } from '../backend/app.js';
import { loadServerSettings } from '../backend/config.js';

const path=(id=encounter,format='summary')=>`/api/v1/encounters/${id}/${format}`;
async function committed(f) {return commit(f,await review(f,await capture(f)));}
const resources=result=>result.body.entry.map(entry=>entry.resource);

test('F01/F04 HTTP: only committed reviewed batch, condition-only Composition-first document, raw headers and fresh identities',async t=>{
  const f=await clinicalFixture(t);await allow(f);
  assert.equal((await f.patient.get(path())).body.error,'SUMMARY_NOT_COMMITTED');
  const d=await capture(f);assert.equal((await f.doctor.get(path())).body.error,'SUMMARY_NOT_COMMITTED');
  const r=await review(f,d);assert.equal((await f.doctor.get(path())).body.error,'SUMMARY_NOT_COMMITTED');
  const c=await commit(f,r),summary=ok(await f.doctor.get(path()));
  assert.equal(summary.history_scope,'COMMITTED_ENCOUNTER_BATCH');assert.equal(summary.fhir_validation,'NOT_RUN');assert.equal(summary.synthetic,true);
  assert.deepEqual(summary.committed_event_ids,c.event_ids);assert.equal(summary.review.reviewed_payload_hash,r.reviewed_payload_hash);
  assert.equal(summary.statements.length,1);assert.equal(summary.statements[0].event.payload.concept.text,'Dyspepsia');
  assert.ok(!JSON.stringify(summary).includes('Ecosprin'));assert.ok(!JSON.stringify(summary).includes('Penicillin'));
  assert.deepEqual(summary.sections.map(s=>s.key),['CONTEXT','PRESCRIPTIONS','CONDITIONS','OTHER_STATEMENTS','NARRATIVE','PROVENANCE']);
  assert.match(summary.sections[1].text,/No prescription item in this committed encounter batch/u);
  const first=await f.doctor.get(path(encounter,'fhir-export')),second=await f.patient.get(path(encounter,'fhir-export'));
  assert.equal(first.status,200,JSON.stringify(first.body));assert.match(first.headers.get('Content-Type'),/^application\/fhir\+json/u);
  assert.equal(first.headers.get('X-FHIR-Validation'),'NOT_RUN');assert.match(first.headers.get('Cache-Control'),/no-store/u);
  assert.equal(first.body.resourceType,'Bundle');assert.equal(first.body.type,'document');assert.equal(first.body.request_id,undefined);
  assert.equal(first.body.identifier.system,'urn:vellum:demo:documents');
  assert.equal(first.headers.get('X-Export-ID'),first.body.identifier.value);assert.match(first.headers.get('Content-Disposition'),/attachment; filename="vellum-[a-f0-9-]+\.json"/u);
  assert.notEqual(first.body.identifier.value,second.body.identifier.value);
  const list=resources(first);assert.deepEqual(list.map(r=>r.resourceType),['Composition','Patient','Condition','Practitioner','Encounter']);
  assert.equal(list[2].verificationStatus.coding[0].code,'unconfirmed');assert.equal(list[2].onsetDateTime,undefined);
  const urls=new Set(first.body.entry.map(entry=>entry.fullUrl));
  for(const entry of first.body.entry) {assert.match(entry.resource.id,/^[a-f0-9-]{36}$/u);assert.equal(entry.fullUrl,`urn:uuid:${entry.resource.id}`);}
  assert.ok(urls.has(list[0].subject.reference));assert.ok(urls.has(list[0].author[0].reference));assert.ok(urls.has(list[0].encounter.reference));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM clinical_events').get().n,4);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM mutation_receipts WHERE operation LIKE '%summary%' OR operation LIKE '%fhir-export%'").get().n,0);
});

test('F02/F03/F09 HTTP: exact prescriptions and provisional conditions; other families retained; escaped reviewed text, no original-source import',async t=>{
  const f=await clinicalFixture(t);await allow(f);
  const original='Original private source wording, replaced explicitly before review.';
  let d=await capture(f,{input_mode:'MANUAL_TEXT',language:'en',text:original});
  const medicine=(status,statement_kind='PRESCRIBED')=>initialItem('MEDICATION_RECORDED',{concept:concept('Metformin','metformin_demo'),statement_kind,status,
    dose_text:status==='ACTIVE'?'5 fictional units':null,route_text:status==='ACTIVE'?'oral':null,frequency_text:status==='ACTIVE'?'BD verbatim':null,duration_text:null,reason:status==='DISCONTINUED'?'Recorded fictional stop reason':null});
  const prescribed=['ACTIVE','COMPLETED','DISCONTINUED','UNKNOWN'].map(status=>medicine(status));prescribed[1].source.kind='PATIENT_REPORT';
  const procedure=initialItem('PROCEDURE_RECORDED',{concept:concept('Cholecystectomy','cholecystectomy_demo'),status:'REPORTED_COMPLETED',note:'Fictional report'},{occurrence_text:'Aug 2021'});
  const negative=initialItem('NEGATIVE_FINDING_RECORDED',{scope:{topic_key:'LATEX_ALLERGY',timeframe:'AT_ASSESSMENT'},declared_by:null,declared_on:'2026-03-15',clinical_basis:'Fictional patient report; testing not documented',scope_text:'Dated limited assessment'}, {occurred_on:'2026-03-15',source:{kind:'PATIENT_REPORT',reference:null,authored_on:null,original_author:null,quote:null}});
  const allergy=initialItem('ALLERGY_RECORDED',{concept:concept('Penicillin','penicillin_demo'),clinical_status:'ACTIVE',verification_status:'UNCONFIRMED',reaction_text:'Fictional reaction <not HTML>',reaction_severity:'UNKNOWN'});
  const prior=JSON.parse(f.store.db.prepare("SELECT event_json FROM clinical_events WHERE event_id='evt_demo_stop'").get().event_json);
  const retraction=initialItem('RECORD_RETRACTED',{reason:'Fictional wrong source withdrawn'}, {entity_id:prior.entity_id,change_kind:'RETRACTION',change_reason:'Fictional wrong source withdrawn',supersedes_event_id:prior.event_id});
  const text='Reviewed fictional note <script>alert("not executable")</script> & தமிழ் हिंदी.\nFollow-up wording only; no appointment.';
  const admin=medicine('COMPLETED','ADMINISTERED');admin.occurred_on='2026-03-15';
  const provisional=condition();provisional.payload.clinical_status='UNKNOWN';
  d=await save(f,d,[...prescribed,provisional,medicine('UNKNOWN','REPORTED_TAKING'),admin,procedure,negative,allergy,retraction],text);
  const c=await commit(f,await review(f,d)),summary=ok(await f.patient.get(path()));
  assert.equal(summary.reviewed_text,text);assert.ok(!JSON.stringify(summary).includes(original));assert.equal(summary.statements.length,11);
  assert.deepEqual(summary.committed_event_ids,c.event_ids);assert.equal(summary.sections[4].text,text);
  for(const eventId of c.event_ids) assert.ok(summary.sections.some(s=>s.event_ids.includes(eventId)));
  const document=await f.patient.get(path(encounter,'fhir-export'));assert.equal(document.status,200,JSON.stringify(document.body));
  const list=resources(document),orders=list.filter(r=>r.resourceType==='MedicationRequest'),conditions=list.filter(r=>r.resourceType==='Condition');
  assert.deepEqual(orders.map(r=>r.status),['active','completed','stopped','unknown']);assert.equal(orders.length,4);
  assert.match(orders[0].dosageInstruction[0].text,/BD verbatim/u);assert.equal(orders[1].reportedBoolean,true);assert.equal(orders[0].requester,undefined);
  assert.equal(orders[2].statusReason.text,'Recorded fictional stop reason');assert.equal(conditions[0].clinicalStatus,undefined);
  assert.equal(conditions[0].onsetDateTime,undefined);assert.equal(conditions[0].asserter,undefined);
  assert.ok(!list.some(r=>['Procedure','AllergyIntolerance','Observation','MedicationStatement','MedicationAdministration','Appointment'].includes(r.resourceType)));
  const narrative=list[0].text.div;assert.ok(narrative.includes('&lt;script&gt;'));assert.ok(!narrative.includes('<script>'));assert.ok(narrative.includes('தமிழ் हिंदी'));
  assert.match(narrative,/Aug 2021/u);assert.match(narrative,/testing not documented/u);assert.match(narrative,/Withdrawal of evidence/u);
  assert.equal(document.body.meta.profile,undefined);
});

test('F05/F12 HTTP: separate summary scope, own patient after closure, and no staff/unrelated/emergency export',async t=>{
  const f=await clinicalFixture(t),other=await actorClient(f,'patient-b'),wrongDoctor=await actorClient(f,'doctor18');await committed(f);
  for(const actor of [f.staff,other,wrongDoctor]) assert.equal((await actor.get(path())).status,404);
  assert.equal((await f.doctor.get(path())).body.error,'HISTORY_LOCKED');
  ok(await f.doctor.post(`/api/v1/encounters/${encounter}/break-glass`,{reason:'Fictional urgent access.'}));
  assert.equal((await f.doctor.get(path())).body.error,'SCOPE_DENIED');
  assert.equal((await f.patient.get(path())).status,200);
  const room=ok(await f.doctor.get('/api/v1/queue/rooms/room_12'));ok(await f.doctor.post(`/api/v1/encounters/${encounter}/complete`,{expected_version:room.version}));
  assert.equal((await f.doctor.get(path())).status,403);
  const summary=ok(await f.patient.get(path()));assert.equal(summary.encounter_status,'CLOSED');
  const document=await f.patient.get(path(encounter,'fhir-export')),context=resources(document).find(r=>r.resourceType==='Encounter');
  assert.equal(context.status,'finished');assert.ok(context.period.end);
  assert.equal((await f.patient.get(`${path()}?mode=EMERGENCY`)).status,422);
});

test('F06/F10 HTTP: revocation during build blocks output and always releases the shared slot',async t=>{
  let before=null;const f=await clinicalFixture(t,{hooks:{async beforeOutputBuild(){if(before){const fn=before;before=null;await fn();}}}});
  const grant=await allow(f);await committed(f);
  before=async()=>{ok(await f.patient.post(`/api/v1/encounters/${encounter}/allowance/revoke`,{grant_id:grant.grant_id,expected_grant_version:0,approval_channel:'PHONE'}));};
  const denied=await f.doctor.get(path(encounter,'fhir-export'));assert.equal(denied.body.error,'GRANT_ENDED');assert.equal(denied.headers.get('Content-Disposition'),null);
  assert.ok(!denied.text.includes('Dyspepsia'));assert.equal(f.app.locals.output.inFlight,0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE operation='FHIR_RELEASE'").get().n,0);
  assert.equal((await f.patient.get(path())).status,200);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM clinical_events').get().n,4);
});

test('F08 HTTP: selected-event correction stales old batch; unrelated append does not; patient closure during build changes context',async t=>{
  let before=null;let f=await clinicalFixture(t,{hooks:{async beforeOutputBuild(){if(before){const fn=before;before=null;await fn();}}}});
  await allow(f);const first=await committed(f),event=JSON.parse(f.store.db.prepare('SELECT event_json FROM clinical_events WHERE event_id=?').get(first.event_ids[0]).event_json);
  f=await nextEncounter(f);await allow(f);await committed(f);
  assert.equal((await f.patient.get(path(encounter))).status,200);
  // A third encounter may correct the first batch; retain the second as unrelated.
  const secondEncounter=f.encounter;f=await nextEncounter(f);await allow(f);
  let d=await capture(f,{input_mode:'MANUAL_TEXT',language:'en',text:'Fictional correction to the original source.'});
  d=await save(f,d,[{event_type:event.event_type,entity_id:event.entity_id,change_kind:'CORRECTION',change_reason:'Fictional source correction',
    supersedes_event_id:event.event_id,occurred_on:event.occurred_on,occurrence_text:event.occurrence_text,source:{...event.source,quote:null},payload:event.payload}]);
  await commit(f,await review(f,d));
  assert.equal((await f.patient.get(path(encounter))).body.error,'SUMMARY_OUTDATED');assert.equal((await f.patient.get(path(secondEncounter))).status,200);
  before=async()=>{const room=ok(await f.doctor.get('/api/v1/queue/rooms/room_12'));ok(await f.doctor.post(`/api/v1/encounters/${f.encounter}/complete`,{expected_version:room.version}));};
  const changed=await f.patient.get(path(f.encounter));assert.equal(changed.body.error,'OUTPUT_CONTEXT_CHANGED');assert.equal(changed.body.sections,undefined);
  assert.equal((await f.patient.get(path(f.encounter))).status,200);
});

test('F07 HTTP: capture hash and committed IDs must exactly match the batch; no partial export',async t=>{
  for(const damaged of ['hash','ids','chain']) await t.test(damaged,async t=>{
    const f=await clinicalFixture(t);await committed(f);
    if(damaged==='chain') {
      f.store.db.exec('DROP TRIGGER clinical_no_update');f.store.db.prepare("UPDATE clinical_events SET event_hash=? WHERE event_id='evt_demo_stop'").run('a'.repeat(64));
    } else {
      f.store.db.exec('DROP TRIGGER draft_terminal_no_update');
      if(damaged==='hash') f.store.db.prepare('UPDATE clinical_drafts SET reviewed_payload_hash=?').run('a'.repeat(64));
      else f.store.db.prepare('UPDATE clinical_drafts SET committed_event_ids_json=?').run('["evt_demo_stop"]');
    }
    const result=await f.patient.get(path(encounter,'fhir-export'));assert.equal(result.body.error,'SUMMARY_SOURCE_INVALID');assert.equal(result.body.entry,undefined);
  });
});

test('F10 HTTP: one shared build slot, audit failure preserves clinical commit; size boundary and strict preflight',{timeout:15000},async t=>{
  let entered,proceed,hold=false;const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{proceed=resolve;});
  const f=await clinicalFixture(t,{hooks:{async beforeOutputBuild(){if(hold){entered();await gate;}}}});await committed(f);
  hold=true;const pending=f.patient.get(path());
  try {await ready;const full=await f.patient.get(path(encounter,'fhir-export'));assert.equal(full.body.error,'EXPORT_BUSY');assert.equal(full.headers.get('Retry-After'),'1');}
  finally {hold=false;proceed();}
  const summary=ok(await pending);assert.equal(f.app.locals.output.inFlight,0);
  f.store.db.exec("CREATE TRIGGER fail_output_audit BEFORE INSERT ON audit_events WHEN NEW.operation='FHIR_RELEASE' BEGIN SELECT RAISE(ABORT,'test'); END");
  assert.equal((await f.patient.get(path(encounter,'fhir-export'))).body.error,'AUDIT_UNAVAILABLE');assert.equal(f.app.locals.output.inFlight,0);
  f.store.db.exec('DROP TRIGGER fail_output_audit');const document=await f.patient.get(path(encounter,'fhir-export'));assert.equal(document.status,200);
  const comparable={...summary,generation_id:document.body.identifier.value,generated_at:document.body.timestamp};
  comparable.sections=summary.sections.map(section=>section.key==='CONTEXT'?{...section,text:section.text.replace(summary.generated_at,document.body.timestamp)}:section);
  const source={encounter:f.store.db.prepare('SELECT * FROM encounters WHERE encounter_id=?').get(encounter)};
  assert.equal(preflightFHIR(document.body,comparable,source),true);
  for(const mutate of [bundle=>{bundle.entry[0].resource.subject.reference=`urn:uuid:${randomUUID()}`;},bundle=>{bundle.entry[0].resource.meta={profile:['unverified']};},
    bundle=>{bundle.entry[2].resource.identifier[0].value='wrong_event';},bundle=>{bundle.entry[0].resource.text.div='<script>bad</script>';},bundle=>{bundle.entry.reverse();}]) {
    const copy=structuredClone(document.body);mutate(copy);assert.throws(()=>preflightFHIR(copy,comparable,source),{code:'FHIR_BUILD_FAILED'});
  }
  assert.equal(boundedOutput('a'.repeat(OUTPUT_LIMIT-2)).length,OUTPUT_LIMIT);
  assert.throws(()=>boundedOutput('a'.repeat(OUTPUT_LIMIT-1)),{code:'EXPORT_TOO_LARGE'});
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM clinical_events').get().n,4);
});

test('F06/F10/F11 HTTP: exact expiry during generation, fresh retry identity and no inherited validation claim',async t=>{
  let time=Date.now()+60000,before=null;
  const f=await clinicalFixture(t,{clock:{utc:()=>time,mono:()=>time},hooks:{beforeOutputBuild(){before?.();}}});
  const grant=await allow(f);await committed(f);
  before=()=>{time=Date.parse(grant.expires_at);before=null;};
  const expired=await f.doctor.get(path());assert.equal(expired.body.error,'GRANT_ENDED');assert.equal(expired.body.reviewed_text,undefined);assert.equal(f.app.locals.output.inFlight,0);
  const first=await f.patient.get(path(encounter,'fhir-export')),second=await f.patient.get(path(encounter,'fhir-export'));
  assert.equal(first.status,200);assert.equal(second.status,200);assert.notEqual(first.body.identifier.value,second.body.identifier.value);
  assert.equal(first.headers.get('X-FHIR-Validation'),'NOT_RUN');assert.equal(second.headers.get('X-FHIR-Validation'),'NOT_RUN');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE operation='FHIR_RELEASE'").get().n,2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM clinical_events').get().n,4);
});

test('F08 HTTP: correction committed while an earlier batch is rendering prevents stale delivery',async t=>{
  let before=null;let f=await clinicalFixture(t,{hooks:{async beforeOutputBuild(){if(before){const fn=before;before=null;await fn();}}}});
  await allow(f);const c=await committed(f),event=JSON.parse(f.store.db.prepare('SELECT event_json FROM clinical_events WHERE event_id=?').get(c.event_ids[0]).event_json);
  f=await nextEncounter(f);await allow(f);
  let d=await capture(f,{input_mode:'MANUAL_TEXT',language:'en',text:'Fictional corrected assessment.'});
  d=await save(f,d,[{event_type:event.event_type,entity_id:event.entity_id,change_kind:'CORRECTION',change_reason:'Fictional source correction',supersedes_event_id:event.event_id,
    occurred_on:event.occurred_on,occurrence_text:event.occurrence_text,source:{...event.source,quote:null},payload:event.payload}]);const r=await review(f,d);
  before=async()=>{await commit(f,r);};
  const stale=await f.patient.get(path(encounter));assert.equal(stale.body.error,'SUMMARY_OUTDATED');assert.equal(stale.body.reviewed_text,undefined);
});

test('F/D recovery HTTP: restored reviewed output retains event bytes, ends recovered access and permits fresh patient self-access',async t=>{
  const f=await clinicalFixture(t);await allow(f);const c=await committed(f);
  const before=f.store.db.prepare('SELECT event_json FROM clinical_events WHERE event_id=?').get(c.event_ids[0]).event_json;
  const dataset=f.store.verification.dataset_id;await f.cleanup();
  const backup=nodePath.join(f.directory,'reviewed-backup.sqlite3'),restored=nodePath.join(f.directory,'reviewed-restored.sqlite3');
  await backupDatabase(f.file,backup);await restoreDatabase(backup,restored);
  const app=await createApp(loadServerSettings({FRONTEND_ORIGIN:f.origin,API_ORIGIN:f.origin,VELLUM_DB_PATH:restored})),server=http.createServer(app);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const stale=await fetch(`${base}${path()}`,{headers:{Cookie:f.patient.login.cookie}});assert.equal(stale.status,401);await stale.arrayBuffer();
    const signIn=await fetch(`${base}/api/v1/auth/login`,{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json','X-Idempotency-Key':randomUUID()},
      body:JSON.stringify({username:'patient-a',password:f.passwords['patient-a']})});
    assert.equal(signIn.status,200);await signIn.arrayBuffer();
    const response=await fetch(`${base}${path()}`,{headers:{Cookie:signIn.headers.get('Set-Cookie').split(';')[0]}});
    assert.equal(response.status,200);const summary=await response.json();assert.deepEqual(summary.committed_event_ids,c.event_ids);assert.notEqual(summary.dataset_id,dataset);
    assert.equal(summary.statements[0].event.review.status,'CLINICIAN_REVIEWED');
    assert.equal(app.locals.store.db.prepare('SELECT event_json FROM clinical_events WHERE event_id=?').get(c.event_ids[0]).event_json,before);
    assert.equal(app.locals.store.db.prepare("SELECT COUNT(*) n FROM encounter_grants WHERE state='ACTIVE'").get().n,0);
  } finally {await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});app.locals.close();}
});
