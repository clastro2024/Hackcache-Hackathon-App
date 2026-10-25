import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {httpFixture} from './helpers.js';

test('S01/S02 demo identity: seven synthetic choices, normal opaque sessions, role binding and unchanged credentials',async t=>{
  const f=await httpFixture(t),before=f.store.db.prepare('SELECT account_id,password_hash,permissions_json FROM accounts ORDER BY account_id').all();
  const list=await f.request('/api/v1/auth/demo/accounts');assert.equal(list.status,200);assert.equal(list.body.simulation,true);assert.equal(list.body.accounts.length,7);
  assert.ok(list.body.accounts.every(a=>!('password' in a)&&!('password_hash' in a)&&!('permissions' in a)));
  const key=randomUUID(),login=await f.request('/api/v1/auth/demo/login',{method:'POST',key,body:{username:'doctor12'}});
  assert.equal(login.status,200);assert.equal(login.body.actor.role,'CLINICIAN');assert.deepEqual(login.body.actor.room_ids,['room_12']);
  assert.match(login.headers.get('set-cookie'),/HttpOnly/u);assert.match(login.headers.get('set-cookie'),/SameSite=Strict/iu);
  assert.equal((await f.request('/api/v1/queue/rooms/room_12',{cookie:login.cookie})).status,200);
  assert.equal((await f.request('/api/v1/queue/rooms/room_18',{cookie:login.cookie})).status,404);
  assert.equal((await f.request('/api/v1/queue/rooms/room_12/pause',{method:'POST',cookie:login.cookie,body:{expected_version:0}})).status,403);
  const replay=await f.request('/api/v1/auth/demo/login',{method:'POST',key,cookie:login.cookie,body:{username:'doctor12'}});assert.equal(replay.body.replayed,true);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE operation='AUTH_DEMO_LOGIN'").get().n,1);
  const patient=await f.request('/api/v1/auth/demo/login',{method:'POST',body:{username:'patient-c'}});assert.equal(patient.body.actor.role,'PATIENT');
  assert.equal((await f.request('/api/v1/patients/me/visit',{cookie:patient.cookie})).status,200);
  assert.equal((await f.request('/api/v1/queue/rooms/room_12',{cookie:patient.cookie})).status,404);
  assert.deepEqual(f.store.db.prepare('SELECT account_id,password_hash,permissions_json FROM accounts ORDER BY account_id').all(),before);
});

test('S02/A02 demo identity: strict account choice, Origin, current active account and orphan receipt guards',async t=>{
  const f=await httpFixture(t);
  for(const body of [{username:'administrator'},{username:'doctor12',role:'STAFF'},{username:'doctor12',password:'unused'}])assert.equal((await f.request('/api/v1/auth/demo/login',{method:'POST',body})).status,422);
  assert.equal((await f.request('/api/v1/auth/demo/login',{method:'POST',body:{username:'staff'},headers:{Origin:'https://untrusted.invalid'}})).status,403);
  const key=randomUUID();assert.equal((await f.request('/api/v1/auth/demo/login',{method:'POST',key,body:{username:'doctor12'}})).status,200);
  assert.equal((await f.request('/api/v1/auth/demo/login',{method:'POST',key,body:{username:'doctor12'}})).body.error,'LOGIN_REAUTH_REQUIRED');
  assert.notEqual(f.store.db.prepare('SELECT revoked_at FROM sessions').get().revoked_at,null);
  f.store.runUnit(true,()=>f.store.db.prepare("UPDATE accounts SET active=0 WHERE username='staff'").run());
  assert.equal((await f.request('/api/v1/auth/demo/login',{method:'POST',body:{username:'staff'}})).status,404);
  assert.equal((await f.request('/api/v1/auth/demo/accounts')).body.accounts.some(a=>a.username==='staff'),false);
});
