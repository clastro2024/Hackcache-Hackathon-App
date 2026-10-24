import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import * as cookie from 'cookie';
import { z } from 'zod';
import { PASSWORD_OPTIONS } from './config.js';
import { actorSchema, sessionResponseSchema, ApiError, id, scopes } from './schemas.js';
import { retryUnit } from './db.js';
import { appendAudit, findReceipt, putReceipt, fingerprint } from './services/audit.js';
import { digest, parseJSON } from './services/vault.js';

export const SESSION_COOKIE = 'vaultmed_session';
const permissions = {
  STAFF:['intake:register','queue:operate','consent:assist'],
  CLINICIAN:['queue:operate','clinical:write','emergency:read'], PATIENT:['patient:self','consent:decide'],
};
export function cookieReference(header='') {
  if(typeof header!=='string' || header.length>4096 ||
    header.split(';').filter(part=>part.split('=')[0].trim()===SESSION_COOKIE).length!==1) return null;
  let secret;
  try {secret=cookie.parseCookie(header)[SESSION_COOKIE];} catch {return null;}
  return /^[A-Za-z0-9_-]{43}$/u.test(secret ?? '')?Object.freeze({secretHash:digest(secret)}):null;
}
export function sessionCookie(settings,secret,expiresAt,now) {
  return cookie.stringifySetCookie({name:SESSION_COOKIE,value:secret,path:'/',httpOnly:true,
    secure:!settings.loopbackHttp,sameSite:'strict',expires:new Date(expiresAt),
    maxAge:Math.max(0,Math.min(7200,Math.floor((expiresAt-now)/1000)))});
}
export const clearSessionCookie = settings => sessionCookie(settings,'',0,0);

export function createLimiter({limit,windowMs=60000,capacity=1000,now}) {
  const entries=new Map();
  function entry(key) {
    const time=now();for(const [name,value] of entries) if(time>=value.end) entries.delete(name);
    let value=entries.get(key);
    if(!value) {
      if(entries.size>=capacity) throw new ApiError('RATE_LIMITED',{retryAfter:1});
      value={count:0,end:time+windowMs};entries.set(key,value);
    }
    if(value.count>=limit) throw new ApiError('RATE_LIMITED',{retryAfter:Math.max(1,Math.ceil((value.end-time)/1000))});
    return value;
  }
  return {check:entry,hit:key=>{entry(key).count+=1;},forget:key=>entries.delete(key),clear:()=>entries.clear(),get size(){return entries.size;}};
}

export async function createAuth(store,settings,{now,hooks={}}) {
  const dummyHash=await argon2.hash(randomBytes(32).toString('base64url'),{...PASSWORD_OPTIONS,type:argon2.argon2id});
  const failures=createLimiter({limit:5,now});const sensitive=createLimiter({limit:60,now});
  let checkingPassword=false;

  function actor(accountId) {
    const account=store.db.prepare(`SELECT account_id,username,role,patient_id,room_ids_json,permissions_json,registration_id,active
      FROM accounts WHERE account_id=?`).get(accountId);
    if(!account || !account.active) throw new ApiError('SESSION_ENDED');
    const roomIds=z.array(id).max(10).parse(parseJSON(account.room_ids_json,8192));
    const flags=z.array(z.string()).max(20).parse(parseJSON(account.permissions_json,8192));
    if(!permissions[account.role] || flags.some(flag=>!permissions[account.role].includes(flag)) ||
      new Set(flags).size!==flags.length || new Set(roomIds).size!==roomIds.length) throw new ApiError('DEPENDENCY_UNAVAILABLE');
    const display=account.role==='PATIENT'?store.db.prepare('SELECT display_name FROM patients WHERE patient_id=?').get(account.patient_id)?.display_name:
      `${account.role==='CLINICIAN'?'Fictional clinician':'Fictional staff'} (${account.username})`;
    const safe=actorSchema.parse({account_id:account.account_id,role:account.role,display_name:display,
      room_ids:roomIds,permissions:flags,...(account.role==='PATIENT'?{patient_id:account.patient_id}:{})});
    return {...safe,registration_id:account.registration_id};
  }
  function authenticate(ref) {
    const time=now();
    if(!ref) throw new ApiError('AUTH_REQUIRED');
    const session=store.db.prepare('SELECT session_id,account_id,csrf_value,created_at,expires_at,revoked_at FROM sessions WHERE secret_hash=?').get(ref.secretHash);
    if(!session || session.revoked_at!==null || time>=session.expires_at) throw new ApiError('SESSION_ENDED');
    return {actor:actor(session.account_id),session,now:time};
  }
  function csrf(ctx,value) {
    if(typeof value!=='string' || value.length>128 || Buffer.byteLength(value)!==Buffer.byteLength(ctx.session.csrf_value) ||
      !timingSafeEqual(Buffer.from(value),Buffer.from(ctx.session.csrf_value))) throw new ApiError('CSRF_REJECTED');
  }
  function safeSession(ctx) {
    const {registration_id,...safe}=ctx.actor;
    return sessionResponseSchema.parse({authenticated:true,actor:safe,expires_at:new Date(ctx.session.expires_at).toISOString(),csrf_token:ctx.session.csrf_value});
  }
  function endSession(sessionId,actorId,reason,time) {
    if(!store.inWriteUnit) throw new ApiError('INTERNAL_ERROR');
    const current=store.db.prepare('SELECT revoked_at FROM sessions WHERE session_id=?').get(sessionId);
    if(!current || current.revoked_at!==null) return;
    store.db.prepare('UPDATE sessions SET revoked_at=? WHERE session_id=?').run(time,sessionId);
    const pending=store.db.prepare("SELECT * FROM consent_requests WHERE clinician_session_id=? AND state IN ('REQUESTED','CLARIFICATION_REQUESTED')").all(sessionId);
    for(const request of pending) {
      const expired=time>=request.expires_at;
      store.db.prepare('UPDATE consent_requests SET state=?,end_reason=?,version=version+1 WHERE request_id=?')
        .run(expired?'EXPIRED':'CANCELLED',expired?'EXPIRED':reason,request.request_id);
      appendAudit(store,{actor_id:actorId,patient_id:request.patient_id,encounter_id:request.encounter_id,
        operation:'AUTH_REQUEST_ENDED',result:expired?'EXPIRED':'CANCELLED',recorded_at:time,
        details:{request_id:request.request_id,session_id:sessionId,reason_code:reason}});
    }
    const grants=store.db.prepare("SELECT * FROM encounter_grants WHERE clinician_session_id=? AND state='ACTIVE'").all(sessionId);
    for(const grant of grants) {
      const expired=time>=grant.expires_at;
      store.db.prepare('UPDATE encounter_grants SET state=?,ended_at=?,end_reason=?,version=version+1 WHERE grant_id=?')
        .run(expired?'EXPIRED':'ENDED',time,expired?'EXPIRED':reason,grant.grant_id);
      appendAudit(store,{actor_id:actorId,patient_id:grant.patient_id,encounter_id:grant.encounter_id,operation:'AUTH_ACCESS_ENDED',
        result:expired?'EXPIRED':'ENDED',recorded_at:time,details:{grant_id:grant.grant_id,session_id:sessionId,reason_code:reason}});
    }
  }
  async function login({username,password,key,ref,sourceIp=''}) {
    const normalized=username.trim().toLowerCase();const pair=digest(`${normalized}\n${sourceIp}`);
    failures.check(pair);
    if(checkingPassword) throw new ApiError('AUTH_BUSY',{retryAfter:1});
    checkingPassword=true;
    let account,matched;
    try {
      account=store.runUnit(false,()=>store.db.prepare('SELECT account_id,password_hash,active FROM accounts WHERE username=?').get(normalized));
      matched=await argon2.verify(account?.password_hash ?? dummyHash,password);
      if(hooks.afterPasswordVerify) await hooks.afterPasswordVerify();
    } catch(error) {throw error instanceof ApiError?error:new ApiError('DEPENDENCY_UNAVAILABLE');}
    finally {checkingPassword=false;}
    if(!matched || !account?.active) {
      failures.hit(pair);
      try {await retryUnit(store,true,()=>appendAudit(store,{actor_id:null,patient_id:null,encounter_id:null,
        operation:'AUTH_LOGIN',result:'DENIED',recorded_at:now(),details:{reason_code:'INVALID_CREDENTIALS'}}));}
      catch {throw new ApiError('AUDIT_UNAVAILABLE');}
      throw new ApiError('INVALID_CREDENTIALS');
    }
    failures.forget(pair);
    const secret=randomBytes(32).toString('base64url');const newRef={secretHash:digest(secret)};
    const sessionId=`session_${randomUUID()}`;const csrfValue=randomBytes(32).toString('base64url');
    const receiptKey={actor_id:account.account_id,operation:'POST /api/v1/auth/login',idempotency_key:key,
      request_fingerprint:fingerprint({method:'POST',path:'/api/v1/auth/login',body:{username:normalized}})};
    const result=await retryUnit(store,true,()=>{
      const time=now();const current=store.db.prepare('SELECT active,password_hash FROM accounts WHERE account_id=?').get(account.account_id);
      if(!current?.active || current.password_hash!==account.password_hash) throw new ApiError('INVALID_CREDENTIALS');
      actor(account.account_id); // current role/permission state before receipt retrieval.
      const receipt=findReceipt(store,receiptKey);
      if(receipt) {
        let ctx;
        try {ctx=authenticate(ref);} catch(error) {if(!['AUTH_REQUIRED','SESSION_ENDED'].includes(error.code)) throw error;}
        if(ctx?.session.session_id===receipt.outcome.session_id && ctx.actor.account_id===account.account_id) {
          return {body:{...safeSession(ctx),changed:receipt.outcome.changed,replayed:true},ref,cookie:null};
        }
        endSession(receipt.outcome.session_id,account.account_id,'LOGIN_ORPHAN',time);
        appendAudit(store,{actor_id:account.account_id,patient_id:null,encounter_id:null,operation:'AUTH_LOGIN_ORPHAN',result:'REAUTH_REQUIRED',
          recorded_at:time,details:{session_id:receipt.outcome.session_id}});
        return {reauth:true,issuance:{status:receipt.outcome.status,expires_at:receipt.outcome.expires_at}};
      }
      const prior=ref?store.db.prepare('SELECT session_id FROM sessions WHERE secret_hash=?').get(ref.secretHash):null;
      if(prior) endSession(prior.session_id,account.account_id,'SESSION_REPLACED',time);
      const expires=time+7200000;
      store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,NULL)').run(sessionId,account.account_id,newRef.secretHash,csrfValue,time,expires);
      const ctx=authenticate(newRef);const body={...safeSession(ctx),changed:true,replayed:false};
      try {
        appendAudit(store,{actor_id:account.account_id,patient_id:ctx.actor.patient_id ?? null,encounter_id:null,
          operation:'AUTH_LOGIN',result:'SUCCESS',recorded_at:time,details:{session_id:sessionId,...(prior?{previous_session_id:prior.session_id}:{})}});
      } catch {throw new ApiError('AUDIT_UNAVAILABLE');}
      putReceipt(store,receiptKey,{status:'SESSION_ISSUED',changed:true,session_id:sessionId,expires_at:body.expires_at},time);
      return {body,ref:newRef,cookie:sessionCookie(settings,secret,expires,time)};
    });
    if(result.reauth) throw new ApiError('LOGIN_REAUTH_REQUIRED',{commitState:'NOT_APPLICABLE',issuance:result.issuance});
    if(hooks.afterLoginCommit) {
      try {await hooks.afterLoginCommit();} catch {throw new ApiError('COMMIT_OUTCOME_UNKNOWN',{commitState:'UNKNOWN'});}
    }
    try {store.runUnit(false,()=>authenticate(result.ref));}
    catch(error) {error.commit_state='UNKNOWN';throw error;} // Issuance already committed; do not claim rollback.
    return result;
  }
  function room(ctx,roomId,permission) {
    const found=store.db.prepare('SELECT * FROM rooms WHERE room_id=?').get(roomId);
    if(!found || !['STAFF','CLINICIAN'].includes(ctx.actor.role) || !ctx.actor.room_ids.includes(roomId) ||
      (ctx.actor.role==='CLINICIAN' && found.clinician_id!==ctx.actor.account_id)) throw new ApiError('RESOURCE_UNAVAILABLE');
    if(permission && !ctx.actor.permissions.includes(permission)) throw new ApiError('SCOPE_DENIED');
    return found;
  }
  function encounter(ref,encounterId,{permission,scope}={}) {
    const ctx=authenticate(ref);const found=store.db.prepare('SELECT * FROM encounters WHERE encounter_id=?').get(encounterId);
    if(!found) throw new ApiError('RESOURCE_UNAVAILABLE');
    room(ctx,found.room_id,permission);
    if(ctx.actor.role==='CLINICIAN' && found.clinician_id!==ctx.actor.account_id) throw new ApiError('RESOURCE_UNAVAILABLE');
    if(scope) {
      if(ctx.actor.role!=='CLINICIAN') throw new ApiError('SCOPE_DENIED');
      if(!scopes.includes(scope)) throw new ApiError('SCOPE_DENIED');
      if(found.closed_at!==null || found.checked_in_at===null) throw new ApiError('HISTORY_LOCKED');
      const facility=store.db.prepare('SELECT facility_id FROM schema_meta WHERE singleton=1').get().facility_id;
      const grant=store.db.prepare('SELECT * FROM encounter_grants WHERE encounter_id=? AND clinician_session_id=? ORDER BY issued_at DESC,grant_id DESC LIMIT 1')
        .get(found.encounter_id,ctx.session.session_id);
      if(!grant) throw new ApiError('HISTORY_LOCKED');
      if(grant.state!=='ACTIVE' || ctx.now>=grant.expires_at) throw new ApiError('GRANT_ENDED');
      if(grant.patient_id!==found.patient_id || grant.clinician_id!==ctx.actor.account_id || grant.facility_id!==facility ||
        grant.purpose!=='OPD_CONSULTATION' || grant.expires_at>ctx.session.expires_at) throw new ApiError('HISTORY_LOCKED');
      const allowed=z.array(z.enum(scopes)).max(5).parse(parseJSON(grant.scopes_json,8192));
      if(!allowed.includes(scope) || (grant.mode==='BREAK_GLASS' && !['triage:read','vault:query'].includes(scope))) throw new ApiError('SCOPE_DENIED');
      if(grant.mode==='PATIENT_APPROVED') {
        const request=store.db.prepare('SELECT * FROM consent_requests WHERE request_id=?').get(grant.request_id);
        if(!request || request.state!=='ALLOWED' || request.encounter_id!==found.encounter_id || request.patient_id!==found.patient_id ||
          request.clinician_id!==ctx.actor.account_id || request.clinician_session_id!==ctx.session.session_id ||
          request.scopes_json!==grant.scopes_json || request.decision_at===null || request.decision_at>=request.expires_at) throw new ApiError('HISTORY_LOCKED');
      }
      return {...ctx,encounter:found,grant};
    }
    return {...ctx,encounter:found};
  }
  return {login,authenticate,csrf,safeSession,endSession,encounter,
    room:(ref,roomId,permission)=>{const ctx=authenticate(ref);return {...ctx,room:room(ctx,roomId,permission)};},
    ownPatient:(ref,patientId)=>{const ctx=authenticate(ref);if(ctx.actor.role!=='PATIENT' || ctx.actor.patient_id!==patientId ||
      !ctx.actor.permissions.includes('patient:self')) throw new ApiError('RESOURCE_UNAVAILABLE');return ctx;},
    status:ref=>store.runUnit(false,()=>{try{return safeSession(authenticate(ref));} catch(error) {
      if(['AUTH_REQUIRED','SESSION_ENDED'].includes(error.code)) return {authenticated:false,actor:null};throw error;}}),
    admitSensitive:ref=>{const ctx=store.runUnit(false,()=>authenticate(ref));sensitive.hit(ctx.actor.account_id);},
    get limiterSize(){return failures.size;},close(){failures.clear();sensitive.clear();},
  };
}
