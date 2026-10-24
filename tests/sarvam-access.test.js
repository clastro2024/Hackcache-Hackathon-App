import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import path from 'node:path';
import { creditStatus,writeCreditConfirmation,sarvamStatus } from '../backend/sarvam-access.js';
import { loadSarvamSettings,resolveSarvamAccessFile } from '../backend/config.js';
import { sarvamSetup } from '../scripts/sarvam-setup.js';
import { ownedDirectory,removeOwned } from './helpers.js';
import { clinicalFixture,allow,ok,capture,encounter } from './clinical-helpers.js';

async function owned(t){const dir=await ownedDirectory();t.after(()=>removeOwned(dir));return path.join(dir,'credit.json');}
test('AI credit file: exact expiry, future/long/invalid/oversized inputs and explicit atomic replacement',async t=>{
  const file=await owned(t),now=Date.now();assert.equal(creditStatus(now,file).available,false);
  const result=writeCreditConfirmation({balance:100,hours:1},file,now);
  assert.equal(result.provider_calls,0);assert.equal(creditStatus(now,file).available,true);
  assert.equal(creditStatus(now+3599999,file).available,true);assert.equal(creditStatus(now+3600000,file).available,false);
  assert.equal(creditStatus(now-1,file).available,false);
  const original=readFileSync(file,'utf8');
  assert.throws(()=>writeCreditConfirmation({balance:50},file,now),{code:'CREDIT_CONFIRMATION_EXISTS'});
  for(const fields of [{balance:0},{balance:-1},{balance:Infinity},{balance:100,hours:25},{balance:100,verifiedAt:'bad'},
    {balance:100,verifiedAt:new Date(now+1).toISOString()}]){
    assert.throws(()=>writeCreditConfirmation({...fields,replace:true},file,now),{code:'INVALID_CREDIT_CONFIRMATION'});
    assert.equal(readFileSync(file,'utf8'),original);
  }
  writeCreditConfirmation({balance:50,replace:true},file,now);assert.equal(creditStatus(now,file).operator_reported_credit_inr,50);
  for(const text of ['{bad','{"x":1,"x":2}','x'.repeat(4097),JSON.stringify({...JSON.parse(original),no_paid_fallback:false}),
    JSON.stringify({...JSON.parse(original),expires_at:new Date(now+86400001).toISOString()})]){
    writeFileSync(file,text);assert.equal(creditStatus(now,file).available,false);
  }
  writeFileSync(file,Buffer.from([0xff,0xfe]));assert.equal(creditStatus(now,file).available,false);
});

test('AI setup: private path constraints, independent configuration, safe status and explicit writes only',async t=>{
  const file=await owned(t),now=Date.now(),env={SARVAM_ENABLED:'true',SARVAM_API_KEY:'never-print-this-sentinel',SARVAM_ACCESS_FILE:file};
  assert.equal(resolveSarvamAccessFile('/etc/secrets/sarvam-free-access.json'),'/etc/secrets/sarvam-free-access.json');
  for(const bad of ['frontend/key.json','data/fixtures/proof.json','../proof.json','//server/share/proof','data/runtime/x:secret','/etc/passwd'])
    assert.throws(()=>resolveSarvamAccessFile(bad),error=>error.field==='SARVAM_ACCESS_FILE');
  assert.throws(()=>sarvamSetup(['credit','--balance-inr','0'],env,now),{code:'INVALID_CREDIT_CONFIRMATION'});
  assert.equal(existsSync(file),false);
  const missing=sarvamSetup(['status'],env,now);assert.equal(missing.reason,'CREDIT_CONFIRMATION_MISSING');assert.equal(existsSync(file),false);
  const written=sarvamSetup(['credit','--balance-inr','100','--hours','1'],env,now);assert.equal(written.provider_calls,0);
  const ready=sarvamSetup(['status'],env,now);assert.equal(ready.status,'READY');
  assert.equal(JSON.stringify(ready).includes(env.SARVAM_API_KEY),false);
  assert.equal(sarvamStatus({...loadSarvamSettings(env),apiKey:''},now).reason,'KEY_MISSING');
  assert.equal(sarvamStatus({...loadSarvamSettings(env),requested:false},now).reason,'DISABLED');
  assert.throws(()=>sarvamSetup(['status','--replace'],env,now),{code:'INVALID_COMMAND_OPTION'});
  assert.throws(()=>sarvamSetup(['credit','--balance-inr','100'],{...env,SARVAM_ACCESS_FILE:'/etc/secrets/sarvam-free-access.json'},now),{code:'RENDER_SECRET_IS_READ_ONLY'});
});

test('AI real file gate HTTP: missing/expired credit preserves core/manual/local paths and makes no provider request',async t=>{
  const file=await owned(t);let time=Date.now()+10000,calls=0;
  const f=await clinicalFixture(t,{clock:{utc:()=>time,mono:()=>time},serverEnv:{SARVAM_ENABLED:'true',SARVAM_API_KEY:'private-stub-key',SARVAM_ACCESS_FILE:file},
    aiOptions:{fetchImpl:async()=>{calls+=1;return new Response(JSON.stringify({model:'sarvam-105b',choices:[{finish_reason:'stop',
      message:{role:'assistant',content:'{"topic_key":"PENICILLIN_ALLERGY"}'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));}}});
  await allow(f);
  const route='/api/v1/ai/records/ask',body={encounter_id:encounter,question:'क्या penicillin allergy का कोई पुराना record है?'};
  assert.equal((await f.doctor.post(route,body)).body.error,'AI_UNAVAILABLE');assert.equal(calls,0);
  writeCreditConfirmation({balance:100,hours:1,verifiedAt:new Date(time-3599000).toISOString()},file,time);
  assert.equal(ok(await f.doctor.post(route,body)).generation_mode,'LIVE_SARVAM');assert.equal(calls,1);
  time+=1000;assert.equal((await f.doctor.post(route,body)).body.error,'AI_UNAVAILABLE');assert.equal(calls,1);
  const local=ok(await f.doctor.post(route,{...body,question:'Penicillin allergy history?'}));assert.equal(local.generation_mode,'LOCAL_FALLBACK');
  assert.equal((await f.doctor.get('/api/v1/queue/rooms/room_12')).status,200);
  const saved=await capture(f,{input_mode:'MANUAL_TEXT',language:'en',text:'Fictional manual care after AI credit expired.'});
  assert.equal(saved.draft.state,'DRAFT');assert.equal(calls,1);
});
