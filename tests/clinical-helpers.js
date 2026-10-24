import assert from 'node:assert/strict';
import { httpFixture, actorClient } from './helpers.js';

export const encounter='encounter_demo_ledger';
export const patientId='patient_demo_ledger';
export const ok=result=>{assert.equal(result.status,200,JSON.stringify(result.body));return result.body;};
export async function clinicalFixture(t,options) {
  const f=await httpFixture(t,options);
  return {...f,doctor:await actorClient(f,'doctor12'),patient:await actorClient(f,'patient-a'),staff:await actorClient(f),encounter};
}
export async function allow(f,scopes=['triage:read','vault:query','affirmation:run','summary:export','vault:read']) {
  const q=ok(await f.doctor.post(`/api/v1/encounters/${f.encounter}/allowance/request`,{explanation:'Review this fictional clinical history.',scopes}));
  return ok(await f.patient.post(`/api/v1/encounters/${f.encounter}/allowance/respond`,{
    consent_request_id:q.consent_request_id,expected_request_version:q.request_version,action:'ALLOW',approval_channel:'PHONE'}));
}
export const capture=async(f,body={input_mode:'MOCK_FIXTURE',language:'hi',fixture_id:'hindi_clip_1_dyspepsia'})=>
  ok(await f.doctor.post('/api/v1/scribe/transcribe',{encounter_id:f.encounter,...body}));
export const save=async(f,d,items=d.draft.items,text=d.draft.text)=>ok(await f.doctor.post(`/api/v1/scribe/drafts/${d.draft_id}/save`,{
  expected_draft_version:d.draft_version,text,items}));
export const review=async(f,d)=>ok(await f.doctor.post(`/api/v1/scribe/drafts/${d.draft_id}/review`,{
  expected_draft_version:d.draft_version,review_confirmed:true}));
export const commitBody=d=>({draft_id:d.draft_id,expected_draft_version:d.draft_version,reviewed_payload_hash:d.reviewed_payload_hash});
export const commit=async(f,d)=>ok(await f.doctor.post('/api/v1/scribe/commit',commitBody(d)));
export const queryBody=(f,question_text='Penicillin allergy history?')=>({patient_id:patientId,encounter_id:f.encounter,question_text});
export const initialItem=(event_type,payload,extra={})=>({event_type,payload,entity_id:null,change_kind:'INITIAL',change_reason:null,
  supersedes_event_id:null,occurred_on:null,occurrence_text:null,source:{kind:'CLINICIAN_ASSESSMENT',reference:null,
    authored_on:null,original_author:null,quote:null},...extra});
export const concept=(text,term_key=null)=>({text,term_key,coding:null});
export const condition=(name='Dyspepsia',key='dyspepsia_demo')=>initialItem('CONDITION_RECORDED',{
  concept:concept(name,key),clinical_status:'ACTIVE',verification_status:'UNCONFIRMED'});
export async function nextEncounter(f) {
  let room=ok(await f.doctor.get('/api/v1/queue/rooms/room_12'));
  ok(await f.doctor.post(`/api/v1/encounters/${f.encounter}/complete`,{expected_version:room.version}));
  room=ok(await f.staff.get('/api/v1/queue/rooms/room_12'));
  // Waiting fixture token is unrelated to the new same-patient consultation; explicitly withdraw it.
  if(f.store.db.prepare("SELECT queue_state FROM visits WHERE token_id='token_demo_3'").get().queue_state==='WAITING') {
    ok(await f.staff.post('/api/v1/queue/tokens/token_demo_3/withdraw',{expected_version:room.version,reason:'Fictional test patient withdrew.'}));
  }
  ok(await f.staff.post('/api/v1/queue/register',{room_id:'room_12',intake_mode:'MANUAL',patient_id:patientId}));
  room=ok(await f.doctor.get('/api/v1/queue/rooms/room_12'));
  const called=ok(await f.doctor.post('/api/v1/queue/rooms/room_12/call-next',{expected_version:room.version}));
  room=ok(await f.doctor.get('/api/v1/queue/rooms/room_12'));
  ok(await f.doctor.post(`/api/v1/encounters/${called.encounter_id}/check-in`,{expected_version:room.version,identity_check_confirmed:true}));
  return {...f,encounter:called.encounter_id};
}
