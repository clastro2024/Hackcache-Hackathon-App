// Explicit live-only check; intentionally excluded from npm test's *.test.js glob.
// Requires operator-confirmed promotional credit. Never prints credentials or provider text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat,readFile,writeFile,unlink } from 'node:fs/promises';
import path from 'node:path';
import { APP_ROOT,loadServerSettings } from '../backend/config.js';
import { privatePath } from '../backend/db.js';
import { clinicalFixture,allow,capture,ok,encounter } from './clinical-helpers.js';
import { ownedDirectory,removeOwned } from './helpers.js';

test('explicit live Sarvam: synthetic topic and saved-note brief through authorized HTTP',{timeout:90000},async t=>{
  assert.equal(process.env.SARVAM_LIVE_SMOKE,'1','Explicit live-smoke opt-in required');
  const credit=Number(process.env.SARVAM_VERIFIED_CREDIT_INR);
  assert.ok(Number.isFinite(credit)&&credit>0,'Operator-confirmed positive promotional credit required');
  const settings=loadServerSettings();assert.ok(settings.sarvam.apiKey,'Private server key required');
  const started=new Date(),runId=randomUUID(),attempts=[];
  const report={schema_version:'sarvam-live-smoke-v1',run_id:runId,started_at:started.toISOString(),
    operator_reported_promotional_credit_inr:credit,synthetic_only:true,ordinary_live_mode_changed:false,
    tasks:[],provider_attempts:attempts,status:'FAILED',quality_scope:'TWO_SYNTHETIC_EXAMPLES_NOT_CLINICAL_VALIDATION'};
  const reportFile=privatePath(`data/reports/sarvam-smoke-${runId}.json`,{createParents:true});
  const accessDirectory=await ownedDirectory();
  const accessFile=privatePath(path.join(accessDirectory,'sarvam-credit.json'));
  const accessText=JSON.stringify({schema_version:'sarvam-free-access-v1',operator_verified:true,
    promotional_credit_remaining_inr:credit,verified_at:started.toISOString(),
    expires_at:new Date(started.getTime()+600000).toISOString(),no_paid_fallback:true})+'\n';
  await writeFile(accessFile,accessText,{flag:'wx',mode:0o600}); // Refuse any existing operator file.
  const created=await lstat(accessFile);
  t.after(async()=>{
    const current=await lstat(accessFile);
    assert.ok(current.isFile()&&!current.isSymbolicLink()&&current.dev===created.dev&&current.ino===created.ino);
    assert.equal(await readFile(accessFile,'utf8'),accessText,'Do not remove another operator\'s changed file');
    await unlink(accessFile);
    await removeOwned(accessDirectory);
  });
  let f;
  try {
    f=await clinicalFixture(t,{serverEnv:{SARVAM_ENABLED:'true',SARVAM_API_KEY:settings.sarvam.apiKey,SARVAM_ACCESS_FILE:accessFile},aiOptions:{
      fetchImpl:async(url,options)=>{
        assert.equal(url,'https://api.sarvam.ai/v1/chat/completions');
        assert.ok(attempts.length<2,'Maximum two provider attempts per explicit smoke run');
        const request=JSON.parse(options.body),entry={task:request.response_format.json_schema.name,http_status:null};
        assert.equal(request.model,'sarvam-105b');assert.equal(request.max_tokens,1024);
        assert.equal(f.store.inWriteUnit,false,'Network must remain outside write units');
        const reserved=f.store.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE operation='AI_RESERVED'").get().n;
        assert.equal(reserved,attempts.length+1,'Durable reservation must precede each egress');
        attempts.push(entry);const response=await fetch(url,options);entry.http_status=response.status;return response;
      }}});
    const counts=()=>({clinical:f.store.db.prepare('SELECT COUNT(*) n FROM clinical_events').get().n,
      reserved:f.store.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE operation='AI_RESERVED'").get().n});
    const question={encounter_id:encounter,question:'क्या penicillin allergy का कोई पुराना record है?'};
    assert.equal((await f.doctor.post('/api/v1/ai/records/ask',question)).body.error,'HISTORY_LOCKED');
    assert.equal(attempts.length,0);await allow(f);
    const before=counts(),key=randomUUID();
    const answer=ok(await f.doctor.post('/api/v1/ai/records/ask',question,{key}));
    assert.equal(answer.generation_mode,'LIVE_SARVAM');assert.equal(answer.ai_status,'COMPLETED');
    assert.equal(answer.interpreted_topic,'PENICILLIN_ALLERGY');assert.equal(answer.certainty_state,'VERIFIED_POSITIVE');
    assert.equal(answer.source_citations[0].event_id,'evt_demo_penicillin');
    report.tasks.push({task:'ASK',status:'PASSED',model:answer.generation.model,usage:answer.generation.usage,
      provider_latency_ms:answer.generation.provider_latency_ms,expected_topic_matched:true,local_citation_preserved:true});
    assert.equal(ok(await f.doctor.post('/api/v1/ai/records/ask',question,{key})).replayed,true);assert.equal(attempts.length,1);
    const note='Fictional test note. Presenting concern: headache since yesterday. No examination findings, assessment, medication or follow-up plan were supplied.';
    const draft=await capture(f,{input_mode:'MANUAL_TEXT',language:'en',text:note});
    const briefKey=randomUUID(),body={draft_id:draft.draft_id,expected_draft_version:draft.draft_version,include_history:false};
    const proposed=ok(await f.doctor.post('/api/v1/ai/consultation/brief',body,{key:briefKey}));
    const proposal=proposed.draft.ai_proposal;
    assert.equal(proposed.draft.state,'DRAFT');assert.equal(proposed.draft.text,note);assert.equal(proposed.draft.original_text,note);
    assert.deepEqual(proposed.draft.items,[]);assert.equal(proposal.include_history,false);assert.deepEqual(proposal.history_event_ids,[]);
    assert.match(proposal.sections.PRESENTING_CONCERN.text,/headache/iu);
    for(const name of ['SUPPLIED_FINDINGS','ASSESSMENT_PLAN','MEDICATIONS','FOLLOW_UP'])assert.equal(proposal.sections[name].text,null);
    assert.equal(counts().clinical,before.clinical);assert.equal(counts().reserved,2);
    const replay=ok(await f.doctor.post('/api/v1/ai/consultation/brief',body,{key:briefKey}));
    assert.equal(replay.replayed,true);assert.equal(attempts.length,2);
    report.tasks.push({task:'BRIEF',status:'PASSED',model:proposal.generation.model,usage:proposal.generation.usage,
      provider_latency_ms:proposal.generation.provider_latency_ms,source_quotes_validated:true,missing_sections_null:true,
      draft_only:true,clinical_event_count_unchanged:true});
    report.safe_replay_no_additional_calls=true;
    report.source_sha256=Object.fromEntries(await Promise.all(['backend/services/sarvam.js','backend/sarvam-access.js','backend/config.js','backend/operations.js','backend/services/capture.js','tests/sarvam-live-smoke.js']
      .map(async file=>[file,createHash('sha256').update(await readFile(path.join(APP_ROOT,file))).digest('hex')])));
    report.status='PASSED';
  }catch(error){report.failure_code=/^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code??'')?error.code:'SMOKE_ASSERTION_FAILED';throw error;}
  finally {
    // Register last, after the fixture's hooks: never label incomplete cleanup as passing.
    t.after(async()=>{
      report.cleanup={temporary_access_removed:!existsSync(accessFile),owned_database_removed:!f||!existsSync(f.directory)};
      if(!Object.values(report.cleanup).every(Boolean))report.status='FAILED';
      report.finished_at=new Date().toISOString();
      await writeFile(reportFile,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
      console.log(JSON.stringify({report:reportFile,status:report.status,provider_attempts:attempts.length,tasks:report.tasks}));
      assert.ok(Object.values(report.cleanup).every(Boolean),'Owned smoke resources must be removed');
    });
  }
});
