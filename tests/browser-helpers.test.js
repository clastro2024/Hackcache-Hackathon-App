import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../frontend/shared/api.js';
import { createSession } from '../frontend/shared/session.js';
import { httpFixture } from './helpers.js';

const reply=(body={},status=200,dataset='dataset_1')=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','X-Dataset-ID':dataset}});
test('A11 browser helper scope: immutable same-key/body retries, credentials and bounded full jitter',async()=>{
  const calls=[],waits=[];let count=0;
  const api=createApiClient({uuid:()=> '11111111-1111-4111-8111-111111111111',random:()=>0.5,sleep:async ms=>{waits.push(ms);},
    fetcher:async(url,options)=>{calls.push({url,...options});count+=1;
      if(count===1) throw new TypeError('transport lost');
      return count===2?reply({error:'EDGE_BUSY',retry_strategy:'SAME_KEY',commit_state:'NOT_APPLIED'},503):reply({changed:true});}});
  api.setSession({authenticated:true,actor:{account_id:'clinician_12'},csrf_token:'fictional-csrf'});
  const body={expected_version:1};const intent=api.createIntent('/queue/rooms/room_12/pause',body);body.expected_version=99;
  assert.equal((await api.command(intent)).changed,true);assert.deepEqual(waits,[125,250]);assert.equal(calls.length,3);
  for(const call of calls) {
    assert.equal(call.headers['X-Idempotency-Key'],intent.key);assert.equal(call.headers['X-CSRF-Token'],'fictional-csrf');
    assert.equal(call.body,'{"expected_version":1}');assert.equal(call.credentials,'include');assert.equal(call.cache,'no-store');
  }
  assert.equal(api.pendingCount,0);
});

test('A11 browser helper scope: conflicts, rate limits and unsafe retry errors are not automatic actions',async()=>{
  for(const [status,body] of [[409,{error:'STATE_VERSION_CONFLICT',retry_strategy:'REFRESH_STATE',commit_state:'NOT_APPLIED'}],
    [429,{error:'RATE_LIMITED',retry_strategy:'NONE',commit_state:'NOT_APPLIED'}],[503,{error:'AUDIT_UNAVAILABLE',retry_strategy:'NONE',commit_state:'NOT_APPLIED'}]]) {
    let calls=0;const api=createApiClient({fetcher:async()=>{calls+=1;return reply(body,status);}});
    await assert.rejects(()=>api.command(api.createIntent('/auth/logout',{})),{code:body.error});assert.equal(calls,1);
  }
  let time=0,calls=0;const api=createApiClient({clock:()=>time,random:()=>0.5,sleep:async()=>{time=5000;},fetcher:async()=>{calls+=1;throw new TypeError('lost');}});
  const intent=api.createIntent('/auth/logout',{});await assert.rejects(()=>api.command(intent),{code:'NETWORK_UNAVAILABLE'});
  assert.equal(calls,1);assert.equal(api.pendingCount,1);
});

test('S05/A01 browser helper scope: dataset and session changes discard pending intents and late replies',async()=>{
  let resolveLate,call=0;
  const api=createApiClient({fetcher:async()=>{call+=1;if(call===1)return reply({});if(call===2)return new Promise(resolve=>{resolveLate=resolve;});return reply({},200,'dataset_2');}});
  const events=[];api.onContextClear(reason=>events.push(reason));await api.read('/auth/session');
  const intent=api.createIntent('/auth/logout',{}),late=api.read('/auth/session');
  await assert.rejects(()=>api.read('/auth/session'),{code:'DATASET_CHANGED'});
  resolveLate(reply({fictional:'stale reply'}));await assert.rejects(()=>late,{code:'CONTEXT_CHANGED'});
  await assert.rejects(()=>api.command(intent),{code:'INTENT_INVALIDATED'});assert.deepEqual(events,['DATASET_CHANGED']);
  const another=api.createIntent('/auth/logout',{});api.setSession({authenticated:true,actor:{account_id:'staff_demo'},csrf_token:'new-csrf'});
  await assert.rejects(()=>api.command(another),{code:'INTENT_INVALIDATED'});
});

test('S05/A11 browser helper scope: transport loss clears clinical context while retaining a bounded uncertain intent',async()=>{
  let healthy=false;const events=[];
  const api=createApiClient({sleep:async()=>{},fetcher:async()=>{if(!healthy)throw new TypeError('lost');return reply({changed:true});}});
  api.onContextClear(reason=>events.push(reason));const intent=api.createIntent('/auth/logout',{});
  await assert.rejects(()=>api.command(intent),{commit_state:'UNKNOWN'});assert.equal(api.pendingCount,1);assert.equal(events.length,3);
  healthy=true;assert.equal((await api.command(intent)).changed,true);assert.equal(api.pendingCount,0);
  for(let i=0;i<20;i++) api.createIntent('/auth/logout',{});
  assert.throws(()=>api.createIntent('/auth/logout',{}),{code:'PENDING_INTENT_LIMIT'});api.clear();assert.equal(api.pendingCount,0);
});

test('AI browser reconciliation: an in-progress reservation retains its original intent without automatic retry',async()=>{
  const calls=[];let complete=false;
  const api=createApiClient({fetcher:async(url,options)=>{calls.push({url,key:options.headers['X-Idempotency-Key'],body:options.body});
    return complete?reply({ai_status:'COMPLETED',replayed:true}):reply({error:'AI_REQUEST_IN_PROGRESS',retry_strategy:'NONE',commit_state:'NOT_APPLIED'},409);}});
  const intent=api.createIntent('/ai/records/ask',{encounter_id:'encounter_demo_ledger',question:'Penicillin allergy history?'});
  await assert.rejects(()=>api.command(intent),{code:'AI_REQUEST_IN_PROGRESS',commit_state:'UNKNOWN'});
  assert.equal(calls.length,1);assert.equal(api.pendingCount,1);
  complete=true;assert.equal((await api.command(intent)).replayed,true);
  assert.equal(calls.length,2);assert.deepEqual(calls[1],calls[0]);assert.equal(api.pendingCount,0);
});

test('S02 browser session helper scope: absolute expiry clears page memory and credentials are discarded after failed login',async()=>{
  let scheduled,cancelled=0;
  const api=createApiClient({fetcher:async()=>reply({authenticated:true,actor:{account_id:'staff_demo'},csrf_token:'fictional',expires_at:new Date(10000).toISOString()})});
  const session=createSession(api,{now:()=>1000,schedule:(fn,ms)=>{scheduled={fn,ms};return 1;},cancel:()=>{cancelled+=1;}});
  await session.recover();assert.equal(scheduled.ms,9000);assert.ok(session.current);scheduled.fn();assert.equal(session.current,null);
  session.dispose();assert.ok(cancelled>0);
  let healthy=false;const keys=[],passwords=[];
  const unavailable=createApiClient({sleep:async()=>{},fetcher:async(url,options)=>{
    keys.push(options.headers['X-Idempotency-Key']);passwords.push(JSON.parse(options.body).password);
    if(!healthy) throw new TypeError('lost');
    return reply({error:'LOGIN_REAUTH_REQUIRED',retry_strategy:'REAUTHENTICATE',commit_state:'NOT_APPLICABLE'},409);
  }}),failed=createSession(unavailable);
  await assert.rejects(()=>failed.signIn('staff','fictional-private-test-password'));assert.equal(unavailable.pendingCount,0);
  healthy=true;await assert.rejects(()=>failed.signIn('staff','reentered-private-password'),{code:'LOGIN_REAUTH_REQUIRED'});
  assert.equal(keys[0],keys[3]);assert.equal(passwords[3],'reentered-private-password');
  await assert.rejects(()=>failed.signIn('staff','reentered-private-password'),{code:'LOGIN_REAUTH_REQUIRED'});
  assert.notEqual(keys[3],keys[4]);failed.dispose();
});

test('S02/A11 shared-helper HTTP integration: login, recovery and CSRF logout against real server with a Node cookie adapter',async t=>{
  const f=await httpFixture(t);let cookie;
  const api=createApiClient({base:`${f.base}/api/v1`,fetcher:async(url,options)=>{
    const response=await fetch(url,{...options,headers:{...options.headers,Origin:f.origin,...(cookie?{Cookie:cookie}:{})}});
    const setCookie=response.headers.get('Set-Cookie');if(setCookie) cookie=setCookie.split(';')[0];return response;
  }});
  const session=createSession(api);t.after(()=>session.dispose());
  assert.equal((await session.signIn('staff',f.passwords.staff)).actor.role,'STAFF');
  const expiry=session.current.expires_at;await session.recover();assert.equal(session.current.expires_at,expiry);
  assert.equal((await session.signOut()).authenticated,false);assert.equal(session.current,null);assert.equal(api.pendingCount,0);
  const route=await api.read('/navigation/route',{origin:'entrance',destination:'room_18',accessibility:'STEP_FREE',language:'hi'});
  assert.equal(route.status,'ROUTE_AVAILABLE');assert.equal(route.language,'hi');
  // This adapter verifies application integration, not a browser's SameSite/CORS/Secure enforcement.
});

test('A11 browser helper scope: Retry-After takes precedence within retry admission',async()=>{
  const waits=[];let time=0,calls=0;
  const api=createApiClient({clock:()=>time,random:()=>0,sleep:async ms=>{waits.push(ms);time+=ms;},fetcher:async()=>{
    calls+=1;if(calls>1)return reply({changed:true});
    const response=reply({error:'EDGE_BUSY',retry_strategy:'SAME_KEY',commit_state:'NOT_APPLIED'},503);response.headers.set('Retry-After','2');return response;
  }});
  assert.equal((await api.command(api.createIntent('/auth/logout',{}))).changed,true);assert.deepEqual(waits,[2000]);
  let blockedCalls=0;const blocked=createApiClient({fetcher:async()=>{blockedCalls+=1;const response=reply({error:'EDGE_BUSY',retry_strategy:'SAME_KEY',commit_state:'NOT_APPLIED'},503);response.headers.set('Retry-After','6');return response;}});
  await assert.rejects(()=>blocked.command(blocked.createIntent('/auth/logout',{})),{code:'EDGE_BUSY'});assert.equal(blockedCalls,1);
});
