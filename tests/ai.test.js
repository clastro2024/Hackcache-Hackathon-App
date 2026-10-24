import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { clinicalFixture,allow,ok,capture,save,review,commit,condition,encounter,patientId } from './clinical-helpers.js';
import { actorClient } from './helpers.js';
import { briefKeys } from '../backend/schemas.js';
import { createSarvam } from '../backend/services/sarvam.js';
import { createApp } from '../backend/app.js';

const askPath='/api/v1/ai/records/ask',briefPath='/api/v1/ai/consultation/brief';
const question={encounter_id:encounter,question:'क्या penicillin allergy का कोई पुराना record है?'};
const response=(result,extra={})=>new Response(JSON.stringify({model:'sarvam-105b',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(result)}}],
  usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15},...extra}),{headers:{'Content-Type':'application/json'}});
const emptyBrief=()=>Object.fromEntries(briefKeys.map(key=>[key,{text:null,note_quotes:[],event_refs:[]}]));
async function setup(t,handler=()=>response({topic_key:'PENICILLIN_ALLERGY'}),extra={}) {
  const requests=[];
  const f=await clinicalFixture(t,{serverEnv:{SARVAM_ENABLED:'true',SARVAM_API_KEY:'private-stub-key'},aiOptions:{accessCheck:()=>true,
    fetchImpl:async(url,options)=>{requests.push({url,options});return handler(url,options);},...extra}});
  return {...f,requests};
}

test('AI off HTTP: no egress, explicit local exact-question fallback, manual notes preserved and strict input',async t=>{
  let calls=0;const f=await clinicalFixture(t,{aiOptions:{fetchImpl(){calls+=1;throw Error('must not run');}}});await allow(f);
  const local=ok(await f.doctor.post(askPath,{encounter_id:encounter,question:'Penicillin allergy history?'}));
  assert.equal(local.ai_status,'UNAVAILABLE');assert.equal(local.generation_mode,'LOCAL_FALLBACK');assert.equal(local.certainty_state,'VERIFIED_POSITIVE');
  const unavailable=await f.doctor.post(askPath,question);assert.equal(unavailable.body.error,'AI_UNAVAILABLE');assert.equal(unavailable.body.supported_questions.length,6);
  const d=await capture(f,{input_mode:'MANUAL_TEXT',language:'en',text:'Fictional saved note.'});
  assert.equal((await f.doctor.post(briefPath,{draft_id:d.draft_id,expected_draft_version:1})).body.error,'AI_UNAVAILABLE');
  assert.equal(calls,0);assert.equal(f.store.db.prepare('SELECT version FROM clinical_drafts').get().version,1);
  assert.equal((await f.doctor.post(askPath,{...question,provider_url:'https://other.example'})).status,422);
});

test('AI interpretation HTTP stub: provider gets question only, evidence remains local, replay has no second call or clinical receipt',async t=>{
  const f=await setup(t);await allow(f);const key=randomUUID();
  const first=ok(await f.doctor.post(askPath,question,{key}));assert.equal(first.replayed,false);assert.equal(first.ai_status,'COMPLETED');
  assert.equal(first.generation_mode,'LIVE_SARVAM');assert.equal(first.interpreted_topic,'PENICILLIN_ALLERGY');assert.equal(first.certainty_state,'VERIFIED_POSITIVE');
  assert.equal(first.source_citations[0].event_id,'evt_demo_penicillin');
  const replay=ok(await f.doctor.post(askPath,question,{key}));assert.equal(replay.replayed,true);assert.equal(replay.query_id,first.query_id);assert.equal(f.requests.length,1);
  const request=f.requests[0];assert.equal(request.url,'https://api.sarvam.ai/v1/chat/completions');assert.equal(request.options.redirect,'error');
  const body=JSON.parse(request.options.body);assert.equal(body.model,'sarvam-105b');assert.equal(body.max_tokens,1024);assert.equal(body.stream,false);assert.equal(body.n,1);
  assert.equal(body.temperature,0);assert.equal(body.reasoning_effort,null);assert.equal(body.response_format.json_schema.strict,true);
  const supplied=body.messages[1].content;assert.ok(!supplied.includes(patientId));assert.ok(!supplied.includes('evt_demo'));assert.ok(!supplied.includes('Fictional clinician'));
  const receipt=f.store.db.prepare("SELECT outcome_json FROM mutation_receipts WHERE operation='POST /api/v1/ai/records/ask'").get().outcome_json;
  assert.ok(!receipt.includes(question.question));assert.ok(!receipt.includes('answer_text'));assert.ok(!receipt.includes('source_citations'));
  assert.equal((await f.doctor.post(askPath,{...question,question:'different'},{key})).body.error,'IDEMPOTENCY_CONFLICT');
});

test('AI auth/egress HTTP stub: no grant or wrong actor cannot call; revocation while provider waits blocks disclosure',async t=>{
  let entered,proceed;const ready=new Promise(r=>{entered=r;}),gate=new Promise(r=>{proceed=r;});
  const f=await setup(t,async()=>{entered();await gate;return response({topic_key:'PENICILLIN_ALLERGY'});});
  assert.equal((await f.doctor.post(askPath,question)).body.error,'HISTORY_LOCKED');assert.equal(f.requests.length,0);
  const other=await actorClient(f,'doctor18');assert.equal((await other.post(askPath,question)).status,404);
  const grant=await allow(f),pending=f.doctor.post(askPath,question);
  try {await ready;ok(await f.patient.post(`/api/v1/encounters/${encounter}/allowance/revoke`,{grant_id:grant.grant_id,expected_grant_version:0,approval_channel:'PHONE'}));}
  finally {proceed();}
  const denied=await pending;assert.equal(denied.body.error,'GRANT_ENDED');assert.equal(denied.body.certainty_state,undefined);assert.equal(f.requests.length,1);
});

test('AI one-call HTTP stub: same pending intent and other intent are rejected; consumed failure is replayed without egress',async t=>{
  let entered,proceed;const ready=new Promise(r=>{entered=r;}),gate=new Promise(r=>{proceed=r;});
  const f=await setup(t,async()=>{entered();await gate;return new Response('private provider error',{status:503});});await allow(f);const key=randomUUID(),pending=f.doctor.post(askPath,question,{key});
  try {await ready;assert.equal((await f.doctor.post(askPath,question,{key})).body.error,'AI_REQUEST_IN_PROGRESS');
    assert.equal((await f.doctor.post(askPath,question)).body.error,'AI_BUSY');}finally{proceed();}
  const failed=await pending;assert.equal(failed.body.error,'AI_PROVIDER_UNAVAILABLE');assert.equal(failed.body.retry_strategy,'NONE');assert.ok(!failed.text.includes('private provider error'));
  assert.equal((await f.doctor.post(askPath,question,{key})).body.error,'AI_PROVIDER_UNAVAILABLE');assert.equal(f.requests.length,1);
});

test('AI brief HTTP stub: notes-only proposal retains source/items, actual generation and review boundary; source edits preserve late replay semantics',async t=>{
  const sections=emptyBrief();sections.PRESENTING_CONCERN={text:'Fictional saved concern.',note_quotes:['Fictional saved concern.'],event_refs:[]};
  const f=await setup(t,()=>response(sections));
  let d=await capture(f,{input_mode:'MANUAL_TEXT',language:'en',text:'Fictional saved concern.'});d=await save(f,d,[condition()]);
  const key=randomUUID(),body={draft_id:d.draft_id,expected_draft_version:d.draft_version,include_history:false};
  const proposal=ok(await f.doctor.post(briefPath,body,{key}));assert.equal(proposal.draft.state,'DRAFT');assert.equal(proposal.draft_version,d.draft_version+1);
  assert.equal(proposal.draft.text,d.draft.text);assert.equal(proposal.draft.original_text,d.draft.original_text);assert.deepEqual(proposal.draft.items,d.draft.items);
  assert.equal(proposal.draft.ai_proposal.include_history,false);assert.deepEqual(proposal.draft.ai_proposal.history_event_ids,[]);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM clinical_events').get().n,3);
  const sent=JSON.parse(JSON.parse(f.requests[0].options.body).messages[1].content);assert.deepEqual(sent.history.records,[]);assert.ok(!f.requests[0].options.body.includes(patientId));
  const applied=await save(f,proposal,proposal.draft.items,'Fictional saved concern. Clinician edited proposal.');
  const stale=ok(await f.doctor.post(briefPath,body,{key}));assert.equal(stale.replayed,true);assert.equal(stale.snapshot_available,false);assert.equal(stale.draft,null);assert.equal(f.requests.length,1);
  await commit(f,await review(f,applied));assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM clinical_events').get().n,4);
});

test('AI brief HTTP stub: literal grounding and known event labels required; denied history cannot be imported',async t=>{
  const sections=emptyBrief();sections.REPORTED_HISTORY={text:'Invented source.',note_quotes:['not in notes'],event_refs:[]};
  const f=await setup(t,()=>response(sections));const d=await capture(f,{input_mode:'MANUAL_TEXT',language:'en',text:'Fictional notes only.'});
  const body={draft_id:d.draft_id,expected_draft_version:1,include_history:true};
  assert.equal((await f.doctor.post(briefPath,body)).body.error,'HISTORY_LOCKED');assert.equal(f.requests.length,0);
  const failed=await f.doctor.post(briefPath,{...body,include_history:false});assert.equal(failed.body.error,'AI_OUTPUT_INVALID');
  sections.REPORTED_HISTORY={text:'Unprovided event.',note_quotes:[],event_refs:['E1']};
  assert.equal((await f.doctor.post(briefPath,{...body,include_history:false})).body.error,'AI_OUTPUT_INVALID');
  assert.equal(f.store.db.prepare('SELECT version FROM clinical_drafts').get().version,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM clinical_events').get().n,3);
});

test('AI source race HTTP stub: saved draft changes during generation cannot be overwritten',async t=>{
  let entered,proceed;const ready=new Promise(r=>{entered=r;}),gate=new Promise(r=>{proceed=r;});const f=await setup(t,async()=>{entered();await gate;return response(emptyBrief());});
  const d=await capture(f,{input_mode:'MANUAL_TEXT',language:'en',text:'Fictional initial note.'});const key=randomUUID();
  const pending=f.doctor.post(briefPath,{draft_id:d.draft_id,expected_draft_version:1,include_history:false},{key});
  try {await ready;await save(f,d,[],'Fictional later saved note.');}finally{proceed();}
  assert.equal((await pending).body.error,'AI_CONTEXT_CHANGED');assert.equal(f.store.db.prepare('SELECT version FROM clinical_drafts').get().version,2);
  assert.equal((await f.doctor.post(briefPath,{draft_id:d.draft_id,expected_draft_version:1,include_history:false},{key})).body.error,'AI_OUTCOME_UNKNOWN');assert.equal(f.requests.length,1);
});

test('AI limits HTTP stub: durable three/minute and thirty/dataset caps; unsupported classification never becomes medical evidence',async t=>{
  const f=await setup(t,()=>response({topic_key:'UNSUPPORTED'}));await allow(f);
  for(let n=0;n<3;n+=1)assert.equal((await f.doctor.post(askPath,question)).body.error,'UNSUPPORTED_QUESTION');
  assert.equal((await f.doctor.post(askPath,question)).body.error,'AI_RATE_LIMITED');assert.equal(f.requests.length,3);
  // Labelled persisted reservations emulate prior attempts after a process restart, without upstream calls.
  const row=f.store.db.prepare("SELECT * FROM audit_events WHERE operation='AI_RESERVED' LIMIT 1").get();
  f.store.runUnit(true,()=>{for(let n=3;n<30;n+=1){const details=JSON.parse(row.details_json);details.idempotency_key=randomUUID();
    f.store.db.prepare('INSERT INTO audit_events(actor_id,patient_id,encounter_id,operation,result,recorded_at,details_json) VALUES(?,?,?,?,?,?,?)')
      .run(row.actor_id,row.patient_id,row.encounter_id,row.operation,row.result,row.recorded_at,JSON.stringify(details));}});
  assert.equal((await f.doctor.post(askPath,question)).body.error,'AI_BUDGET_EXHAUSTED');assert.equal(f.requests.length,3);
});

test('AI history brief HTTP stub: minimal labelled sources, source-linked proposal, current grant before cached delivery',async t=>{
  const sections=emptyBrief();sections.REPORTED_HISTORY={text:'Recorded penicillin source.',note_quotes:[],event_refs:['E1']};
  const f=await setup(t,()=>response(sections)),grant=await allow(f);
  const d=await capture(f,{input_mode:'MANUAL_TEXT',language:'en',text:'Fictional notes.'});
  const key=randomUUID(),body={draft_id:d.draft_id,expected_draft_version:1,include_history:true};
  const proposed=ok(await f.doctor.post(briefPath,body,{key}));
  const sent=JSON.parse(JSON.parse(f.requests[0].options.body).messages[1].content);
  assert.equal(sent.synthetic,true);assert.equal(sent.history.included,true);assert.equal(sent.history.records.length,2);
  assert.equal(sent.history.total_usable_records,2);assert.equal(sent.history.omitted_records,0);
  assert.ok(sent.history.records.every(record=>!('event_id' in record)&&!('declared_by' in record.payload)));
  assert.ok(!f.requests[0].options.body.includes(patientId));
  assert.equal(proposed.draft.ai_proposal.history_event_ids.length,2);assert.equal(proposed.draft.ai_proposal.history_as_of_sequence,2);
  ok(await f.patient.post(`/api/v1/encounters/${encounter}/allowance/revoke`,{grant_id:grant.grant_id,expected_grant_version:0,approval_channel:'PHONE'}));
  const replay=await f.doctor.post(briefPath,body,{key});assert.equal(replay.body.error,'GRANT_ENDED');assert.equal(replay.body.draft,undefined);
  assert.equal(f.requests.length,1);
  assert.equal((await f.doctor.get(`/api/v1/encounters/${encounter}/draft`)).body.error,'GRANT_ENDED');
});

test('AI audit HTTP stub: reservation failure prevents egress; result-audit failure leaves consumed uncertainty',async t=>{
  const f=await setup(t);await allow(f);
  f.store.db.exec("CREATE TRIGGER fail_ai_reservation BEFORE INSERT ON audit_events WHEN NEW.operation='AI_RESERVED' BEGIN SELECT RAISE(ABORT,'test'); END");
  assert.equal((await f.doctor.post(askPath,question)).body.error,'AUDIT_UNAVAILABLE');assert.equal(f.requests.length,0);
  f.store.db.exec('DROP TRIGGER fail_ai_reservation');
  f.store.db.exec("CREATE TRIGGER fail_ai_result BEFORE INSERT ON audit_events WHEN NEW.operation='AI_RESULT' BEGIN SELECT RAISE(ABORT,'test'); END");
  const key=randomUUID();assert.equal((await f.doctor.post(askPath,question,{key})).body.error,'AUDIT_UNAVAILABLE');
  f.store.db.exec('DROP TRIGGER fail_ai_result');
  assert.equal((await f.doctor.post(askPath,question,{key})).body.error,'AI_OUTCOME_UNKNOWN');assert.equal(f.requests.length,1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE operation='AI_RESERVED'").get().n,1);
});

test('AI ordinary database reopen HTTP stub: completed receipt and orphan reservation survive without another call',async t=>{
  const f=await setup(t);await allow(f);const key=randomUUID();
  const first=ok(await f.doctor.post(askPath,question,{key}));
  const orphan=randomUUID();f.store.db.exec("CREATE TRIGGER fail_ai_result BEFORE INSERT ON audit_events WHEN NEW.operation='AI_RESULT' BEGIN SELECT RAISE(ABORT,'test'); END");
  assert.equal((await f.doctor.post(askPath,question,{key:orphan})).body.error,'AUDIT_UNAVAILABLE');
  f.store.db.exec('DROP TRIGGER fail_ai_result');await f.cleanup();
  let calls=0;const app=await createApp({...f.settings,sarvam:{...f.settings.sarvam,requested:false}},
    {aiOptions:{accessCheck:()=>true,fetchImpl:async()=>{calls+=1;throw Error('no second call');}}});
  // Reuse the owned listener/cleanup closure while replacing the closed application and database.
  f.server.removeAllListeners('request');f.server.on('request',app);f.app.locals.close=app.locals.close;
  await new Promise(resolve=>f.server.listen(Number(new URL(f.base).port),'127.0.0.1',resolve));
  const replay=ok(await f.doctor.post(askPath,question,{key}));assert.equal(replay.replayed,true);assert.equal(replay.query_id,first.query_id);
  assert.equal((await f.doctor.post(askPath,question,{key:orphan})).body.error,'AI_OUTCOME_UNKNOWN');assert.equal(calls,0);
});

test('AI adapter stub: malformed/truncated/tool/oversized output, finite usage, timeout and credit failures are safe and never retried',async()=>{
  const settings={valid:true,requested:true,apiKey:'secret-test-only'};
  for(const produce of [()=>response({topic_key:'PENICILLIN_ALLERGY',certainty_state:'fake'}),()=>response({topic_key:'PENICILLIN_ALLERGY'},{choices:[{finish_reason:'length',message:{role:'assistant',content:'{}'}}]}),
    ()=>new Response('x'.repeat(65537)),()=>response({topic_key:'PENICILLIN_ALLERGY'},{usage:{prompt_tokens:-1}}),
    ()=>response({topic_key:'PENICILLIN_ALLERGY'},{choices:[{finish_reason:'stop',message:{role:'assistant',content:'{}',tool_calls:[{}]}}]})]) {
    let calls=0;const adapter=createSarvam(settings,{accessCheck:()=>true,fetchImpl:async()=>{calls+=1;return produce();}});
    await assert.rejects(()=>adapter.classify('fictional'),{code:'AI_OUTPUT_INVALID'});assert.equal(calls,1);
  }
  let calls=0;const credit=createSarvam(settings,{accessCheck:()=>true,fetchImpl:async()=>{calls+=1;return new Response('secret provider text',{status:402});}});
  await assert.rejects(()=>credit.classify('fictional'),{code:'AI_PROVIDER_UNAVAILABLE'});await assert.rejects(()=>credit.classify('fictional'),{code:'AI_UNAVAILABLE'});assert.equal(calls,1);
  const timeout=createSarvam(settings,{accessCheck:()=>true,timeoutMs:20,fetchImpl:async()=>new Response(new ReadableStream({start(){}}))});
  await assert.rejects(()=>timeout.classify('fictional'),{code:'AI_PROVIDER_UNAVAILABLE'});
  let gated=0;const unavailable=createSarvam(settings,{accessCheck:()=>false,fetchImpl:async()=>{gated+=1;}});
  await assert.rejects(()=>unavailable.classify('fictional'),{code:'AI_UNAVAILABLE'});assert.equal(gated,0);
  const bounded=createSarvam(settings,{accessCheck:()=>true,fetchImpl:async()=>{gated+=1;}});
  await assert.rejects(()=>bounded.classify('x'.repeat(24577)),{code:'AI_CONTEXT_TOO_LARGE'});assert.equal(gated,0);
});
