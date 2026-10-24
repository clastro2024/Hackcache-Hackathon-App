import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { httpFixture } from './helpers.js';
import { cookieReference, createLimiter, sessionCookie } from '../backend/auth.js';
import { appendAudit } from '../backend/services/audit.js';
import { canonicalJSON, digest } from '../backend/services/vault.js';

// Consent rows here are explicit storage fixtures, not evidence of a consent HTTP workflow.
export function grantFixture(f,login,{pending=false}={}) {
  const {store}=f,now=f.app.locals.now();
  const session=store.db.prepare('SELECT session_id FROM sessions WHERE secret_hash=?').get(cookieReference(login.cookie).secretHash).session_id;
  const request=`request_${randomUUID()}`,grant=`grant_${randomUUID()}`;
  const scopes=canonicalJSON(['triage:read','vault:query','summary:export']);
  store.runUnit(true,()=>{
    store.db.prepare(`INSERT INTO consent_requests VALUES(?, 'encounter_demo_ledger','patient_demo_ledger','clinician_12',?,
      'facility_demo','OPD_CONSULTATION',?,'Fictional test permission',?,?,?,0,?,?,?,?,NULL)`)
      .run(request,session,scopes,pending?'REQUESTED':'ALLOWED',now,now+300000,
        pending?null:now,pending?null:'account_patient_1',pending?null:'PHONE',null);
    if(!pending) {
      const audit=appendAudit(store,{actor_id:'account_patient_1',patient_id:'patient_demo_ledger',encounter_id:'encounter_demo_ledger',
        operation:'CONSENT_ALLOW',result:'SUCCESS',recorded_at:now,details:{request_id:request,mode:'PATIENT_APPROVED'}});
      store.db.prepare(`INSERT INTO encounter_grants VALUES(?,?,'encounter_demo_ledger','patient_demo_ledger','clinician_12',?,
        'facility_demo','OPD_CONSULTATION',?,'PATIENT_APPROVED','ACTIVE',?,?,NULL,NULL,?,0)`).run(grant,request,session,scopes,now,now+900000,audit);
    }
  });
  return {session,request,grant,now};
}

test('S01/S02 HTTP scope: fixed actors, opaque cookie hash, selected flags and absolute session recovery',async t=>{
  const f=await httpFixture(t);const login=await f.login('doctor12');
  assert.equal(login.status,200);assert.equal(login.body.actor.role,'CLINICIAN');
  assert.equal(login.body.actor.account_id,'clinician_12');assert.deepEqual(login.body.actor.room_ids,['room_12']);
  const setCookie=login.headers.get('Set-Cookie');assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Strict/);
  assert.match(setCookie,/Path=\//);assert.match(setCookie,/Max-Age=7200/);assert.doesNotMatch(setCookie,/Domain=|Secure/);
  assert.match(sessionCookie({...f.settings,loopbackHttp:false},'a'.repeat(43),7200000,0),/Secure/);
  const secret=login.cookie.split('=')[1];assert.equal(secret.length,43);
  const row=f.store.db.prepare('SELECT * FROM sessions').get();assert.equal(row.secret_hash,digest(secret));
  const encoded=f.store.db.prepare("SELECT password_hash FROM accounts WHERE account_id='clinician_12'").get().password_hash;
  assert.ok(encoded.startsWith('$argon2id$v=19$'));
  assert.deepEqual(encoded.split('$')[3].split(',').sort(),['m=19456','p=1','t=2']);
  assert.equal(row.expires_at-row.created_at,7200000);assert.equal(Date.parse(login.body.expires_at),row.expires_at);
  const receipts=JSON.stringify(f.store.db.prepare('SELECT * FROM mutation_receipts').all());
  for(const value of [secret,f.passwords.doctor12,'password_hash',row.csrf_value]) assert.equal(receipts.includes(value),false);
  assert.equal(login.text.includes(secret),false);assert.equal(login.text.includes(f.passwords.doctor12),false);
  const status=await f.request('/api/v1/auth/session',{cookie:login.cookie});
  assert.equal(status.body.csrf_token,login.body.csrf_token);assert.equal(status.body.expires_at,login.body.expires_at);
  assert.equal(status.headers.get('Set-Cookie'),null);assert.equal(status.headers.get('Cache-Control'),'no-store');
  const staff=await f.login('staff'),patient=await f.login('patient-a');
  assert.equal(staff.body.actor.role,'STAFF');assert.equal(patient.body.actor.patient_id,'patient_demo_ledger');
  const forged=await f.login('staff',{body:{username:'staff',password:f.passwords.staff,role:'CLINICIAN'}});
  assert.equal(forged.status,422);assert.equal(forged.body.fields[0].path,'body');
});

test('S02/A13 login reconciliation: credentials first, matching cookie replay, lost-cookie orphan termination',async t=>{
  const f=await httpFixture(t);const key=randomUUID();const first=await f.login('doctor12',{key});
  const replay=await f.login('doctor12',{key,cookie:first.cookie});
  assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.equal(replay.headers.get('Set-Cookie'),null);
  assert.equal(replay.body.expires_at,first.body.expires_at);
  const denied=await f.login('doctor12',{key,cookie:first.cookie,body:{username:'doctor12',password:'incorrect-private-test-value'}});
  assert.equal(denied.status,401);assert.equal(denied.body.error,'INVALID_CREDENTIALS');
  const orphan=await f.login('doctor12',{key});assert.equal(orphan.status,409);assert.equal(orphan.body.error,'LOGIN_REAUTH_REQUIRED');
  assert.equal(orphan.body.commit_state,'NOT_APPLICABLE');assert.equal(orphan.body.issuance.expires_at,first.body.expires_at);
  assert.match(orphan.headers.get('Set-Cookie'),/Max-Age=0/);
  assert.equal((await f.request('/api/v1/auth/session',{cookie:first.cookie})).body.authenticated,false);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,1);
  assert.equal((await f.login('doctor12')).status,200);
});

test('S02/S07 logout scope: patient logout preserves the choice; clinician replacement ends only that browser access',async t=>{
  const f=await httpFixture(t);const doctor=await f.login(),otherDevice=await f.login();
  const grant=grantFixture(f,doctor);const pending=grantFixture(f,doctor,{pending:true});
  const patient=await f.login('patient-a');
  const logout=await f.request('/api/v1/auth/logout',{method:'POST',body:{},cookie:patient.cookie,csrf:patient.body.csrf_token});
  assert.equal(logout.status,200);assert.equal(logout.body.authenticated,false);
  assert.equal(f.store.db.prepare('SELECT state FROM encounter_grants WHERE grant_id=?').get(grant.grant).state,'ACTIVE');
  const replacement=await f.login('staff',{cookie:doctor.cookie});assert.equal(replacement.status,200);
  assert.equal(f.store.db.prepare('SELECT state,end_reason FROM encounter_grants WHERE grant_id=?').get(grant.grant).end_reason,'SESSION_REPLACED');
  assert.equal(f.store.db.prepare('SELECT state FROM consent_requests WHERE request_id=?').get(pending.request).state,'CANCELLED');
  assert.equal((await f.request('/api/v1/auth/session',{cookie:otherDevice.cookie})).body.authenticated,true);
  assert.equal((await f.request('/api/v1/auth/session',{cookie:doctor.cookie})).body.authenticated,false);
});

test('S03/A12 HTTP scope: Origin, CSRF and UUID key precede logout; revoked session cannot replay receipt',async t=>{
  const f=await httpFixture(t);const login=await f.login();const base={method:'POST',body:{},cookie:login.cookie,csrf:login.body.csrf_token};
  for(const [headers,code] of [[{Origin:''},'ORIGIN_REJECTED'],[{'X-CSRF-Token':'wrong'},'CSRF_REJECTED'],
    [{'X-Idempotency-Key':'not-a-uuid'},'VALIDATION_ERROR'],[{'Content-Type':'application/x-www-form-urlencoded'},'UNSUPPORTED_MEDIA_TYPE']]) {
    const denied=await f.request('/api/v1/auth/logout',{...base,headers});assert.equal(denied.body.error,code);
  }
  assert.equal(f.store.db.prepare('SELECT revoked_at FROM sessions').get().revoked_at,null);
  const key=randomUUID();assert.equal((await f.request('/api/v1/auth/logout',{...base,key})).status,200);
  const replay=await f.request('/api/v1/auth/logout',{...base,key});
  assert.equal(replay.status,401);assert.equal(replay.body.error,'SESSION_ENDED');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM mutation_receipts WHERE operation='POST /api/v1/auth/logout'").get().n,1);
});

test('S13 login bounds: five failed attempts, bounded source-account keys and expired-window pruning',async t=>{
  const f=await httpFixture(t);
  for(let i=0;i<5;i++) assert.equal((await f.login('doctor12',{body:{username:'doctor12',password:'wrong'}})).status,401);
  const limited=await f.login('doctor12');assert.equal(limited.status,429);assert.equal(limited.body.error,'RATE_LIMITED');
  assert.ok(Number(limited.headers.get('Retry-After'))>0);
  let time=0;const limiter=createLimiter({limit:5,capacity:1000,now:()=>time});
  for(let i=0;i<1000;i++) limiter.check(`key_${i}`);
  assert.equal(limiter.size,1000);assert.throws(()=>limiter.check('new'),{code:'RATE_LIMITED'});
  time=60000;limiter.check('new');assert.equal(limiter.size,1);
});

test('S13 login race: one verification outside transactions; changed credentials cannot issue a session',async t=>{
  let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const f=await httpFixture(t,{hooks:{afterPasswordVerify:async()=>{assert.equal(f.store.db.inTransaction,false);enter();await gate;}}});
  const first=f.login();await entered;
  try {
    const second=await f.login('staff');assert.equal(second.status,429);assert.equal(second.body.error,'AUTH_BUSY');
    f.store.runUnit(true,()=>f.store.db.prepare('UPDATE accounts SET active=0 WHERE account_id=?').run('clinician_12'));
  } finally {release();}
  const result=await first;assert.equal(result.status,401);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);
});

test('S02/R03 HTTP scope: exact expiry and backward clock fail closed without extending a session',async t=>{
  let time=Date.now()+1000,mono=0;
  const f=await httpFixture(t,{clock:{utc:()=>time,mono:()=>mono}});const login=await f.login();
  const expiry=Date.parse(login.body.expires_at);time=expiry-1;mono+=1;
  assert.equal((await f.request('/api/v1/auth/session',{cookie:login.cookie})).body.authenticated,true);
  time=expiry;mono+=1;assert.equal((await f.request('/api/v1/auth/session',{cookie:login.cookie})).body.authenticated,false);
  time-=1;mono+=1;
  assert.equal((await f.request('/api/v1/auth/session',{cookie:login.cookie})).body.error,'TIME_UNTRUSTED');
  const ready=await f.request('/api/v1/health/ready');assert.equal(ready.status,503);assert.equal(ready.body.commit_state,'NOT_APPLICABLE');
  assert.equal((await f.request('/api/v1/health/live')).status,200);
});

test('S04/S05 guard scope: current room, patient, session and 900-second grant binding',async t=>{
  let time=Date.now()+1000;
  const f=await httpFixture(t,{clock:{utc:()=>time,mono:()=>time}});
  const login=await f.login(),staff=await f.login('staff'),patient=await f.login('patient-a');
  const auth=f.app.locals.auth,ref=cookieReference(login.cookie);
  const read=(reference,id,options)=>f.store.runUnit(false,()=>auth.encounter(reference,id,options));
  assert.throws(()=>read(ref,'encounter_demo_negative'),{code:'RESOURCE_UNAVAILABLE'});
  assert.throws(()=>read(ref,'encounter_demo_ledger',{scope:'vault:query'}),{code:'HISTORY_LOCKED'});
  const grant=grantFixture(f,login);
  assert.equal(read(ref,'encounter_demo_ledger',{scope:'vault:query'}).grant.grant_id,grant.grant);
  assert.throws(()=>read(cookieReference(staff.cookie),'encounter_demo_ledger',{scope:'vault:query'}),{code:'SCOPE_DENIED'});
  assert.throws(()=>f.store.runUnit(false,()=>auth.ownPatient(cookieReference(patient.cookie),'patient_demo_negative')),{code:'RESOURCE_UNAVAILABLE'});
  assert.throws(()=>read(ref,'encounter_demo_ledger',{scope:'vault:read'}),{code:'SCOPE_DENIED'});
  time=grant.now+900000;
  assert.throws(()=>read(ref,'encounter_demo_ledger',{scope:'vault:query'}),{code:'GRANT_ENDED'});
});

test('A02/A03 HTTP parsing scope: strict UTF-8, duplicate keys, bounded chunked body, safe errors and exact CORS',async t=>{
  const f=await httpFixture(t);
  for(const body of ['{"username":"staff","username":"doctor12","password":"private"}', '{"username":1e999,"password":"p"}', '{', '[]']) {
    const response=await f.request('/api/v1/auth/login',{method:'POST',body});
    assert.ok([400,422].includes(response.status));assert.ok(response.headers.get('X-Request-ID'));
    assert.equal(response.body.request_id,response.headers.get('X-Request-ID'));assert.equal(response.text.includes('private'),false);
  }
  const chunked=await new Promise((resolve,reject)=>{
    const req=http.request(`${f.base}/api/v1/auth/login`,{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json','X-Idempotency-Key':randomUUID()}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;});res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
    });req.on('error',reject);req.write(' '.repeat(32768));req.write(' '.repeat(32768));req.end('{}');
  });
  assert.equal(chunked.status,413);assert.equal(chunked.body.error,'PAYLOAD_TOO_LARGE');
  const invalidUtf8=await fetch(`${f.base}/api/v1/auth/login`,{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json','X-Idempotency-Key':randomUUID()},body:Buffer.from([0xff])});
  assert.equal(invalidUtf8.status,400);await invalidUtf8.arrayBuffer();
  const cors=await f.request('/api/v1/auth/session',{headers:{Origin:f.origin}});assert.equal(cors.headers.get('Access-Control-Allow-Origin'),f.origin);
  assert.equal(cors.headers.get('Access-Control-Allow-Credentials'),'true');
  const foreign=await f.request('/api/v1/auth/session',{headers:{Origin:'https://untrusted.example'}});assert.equal(foreign.headers.get('Access-Control-Allow-Origin'),null);
  const options=await f.request('/api/v1/auth/login',{method:'OPTIONS',headers:{Origin:f.origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,x-idempotency-key'}});
  assert.equal(options.status,204);
});

test('R01/R06 HTTP scope: minimal current readiness, no clinical placeholders or private static files',async t=>{
  const f=await httpFixture(t);const count=f.store.db.prepare('SELECT COUNT(*) n FROM audit_events').get().n;
  for(const route of ['/api/v1/health/live','/api/v1/health/ready']) {
    const result=await f.request(route);assert.equal(result.status,200);assert.equal(result.headers.get('X-Dataset-ID'),null);
    assert.deepEqual(Object.keys(result.body).sort(),['request_id','server_time','status']);
  }
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM audit_events').get().n,count);
  for(const route of ['/api/v1/patients','/api/v1/vault/query','/data/fixtures/seed.json','/.env','/backend/auth.js','/node_modules/express/package.json','/login/.env']) {
    const response=await f.request(route);assert.equal(response.status,404);assert.equal(response.body.error,'RESOURCE_UNAVAILABLE');
  }
  const page=await f.request('/login/');assert.equal(page.status,200);assert.match(page.headers.get('Content-Security-Policy'),/script-src 'self'/);
  assert.equal(page.headers.get('X-Powered-By'),null);assert.equal(page.headers.get('X-Content-Type-Options'),'nosniff');
  f.store.close();assert.equal((await f.request('/api/v1/health/ready')).status,503);assert.equal((await f.request('/api/v1/health/live')).status,200);
});

test('S11/A11 HTTP scope: audit failure rolls login back; post-commit loss returns UNKNOWN and reconciles',async t=>{
  const f=await httpFixture(t);
  f.store.db.exec("CREATE TRIGGER test_fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'private-test-failure'); END");
  const failed=await f.login();assert.equal(failed.status,503);assert.equal(failed.body.error,'AUDIT_UNAVAILABLE');assert.equal(failed.body.commit_state,'NOT_APPLIED');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM mutation_receipts').get().n,0);
  f.store.db.exec('DROP TRIGGER test_fail_audit');
  let once=true;const lost=await httpFixture(t,{hooks:{afterLoginCommit:()=>{if(once){once=false;throw new Error('private');}}}});
  const key=randomUUID(),unknown=await lost.login('doctor12',{key});assert.equal(unknown.body.error,'COMMIT_OUTCOME_UNKNOWN');assert.equal(unknown.body.commit_state,'UNKNOWN');
  assert.equal(unknown.headers.get('Set-Cookie'),null);assert.equal(lost.store.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,1);
  assert.equal((await lost.login('doctor12',{key})).body.error,'LOGIN_REAUTH_REQUIRED');
});

test.todo('S acceptance remaining: complete consent/clinical routes, hosted browser cookie enforcement and end-to-end revocation races');
