import { randomBytes, randomUUID } from 'node:crypto';
import { ApiError, defaultScopes, scopes } from '../schemas.js';
import { requireStorage, retryUnit } from '../db.js';
import { appendAudit } from './audit.js';
import { canonicalJSON, parseJSON } from './vault.js';

const pending=state=>['REQUESTED','CLARIFICATION_REQUESTED'].includes(state);
const iso=time=>new Date(time).toISOString();
const fail=code=>{throw new ApiError(code);};

// Caller owns the transaction. Queue closure must never commit separately from termination.
export function endEncounterAccess(store,encounterId,reason,time,actorId) {
  requireStorage(store.inWriteUnit,'WRITE_UNIT_REQUIRED');
  for(const row of store.db.prepare("SELECT * FROM consent_requests WHERE encounter_id=? AND state IN ('REQUESTED','CLARIFICATION_REQUESTED')").all(encounterId)) {
    const state=time>=row.expires_at?'EXPIRED':'CANCELLED';
    store.db.prepare('UPDATE consent_requests SET state=?,end_reason=?,version=version+1 WHERE request_id=?').run(state,state==='EXPIRED'?'EXPIRED':reason,row.request_id);
    appendAudit(store,{actor_id:actorId,patient_id:row.patient_id,encounter_id:encounterId,operation:'CONSENT_REQUEST_ENDED',result:state,
      recorded_at:time,details:{request_id:row.request_id,reason_code:reason}});
  }
  for(const row of store.db.prepare("SELECT * FROM encounter_grants WHERE encounter_id=? AND state='ACTIVE'").all(encounterId)) {
    const state=time>=row.expires_at?'EXPIRED':'ENDED';
    store.db.prepare('UPDATE encounter_grants SET state=?,ended_at=?,end_reason=?,version=version+1 WHERE grant_id=?').run(state,time,state==='EXPIRED'?'EXPIRED':reason,row.grant_id);
    appendAudit(store,{actor_id:actorId,patient_id:row.patient_id,encounter_id:encounterId,operation:'CONSENT_ACCESS_ENDED',result:state,
      recorded_at:time,details:{grant_id:row.grant_id,reason_code:reason}});
  }
}

export function createConsent(store,auth,operations,{now}) {
  const db=store.db;
  const getRequest=id=>db.prepare('SELECT * FROM consent_requests WHERE request_id=?').get(id);
  const getGrant=id=>db.prepare('SELECT * FROM encounter_grants WHERE grant_id=?').get(id);
  function contextLive(row,time) {
    const context=db.prepare(`SELECT e.closed_at,e.checked_in_at,e.clinician_id,e.room_id,r.clinician_id assigned,
      s.account_id,s.expires_at,s.revoked_at,a.active,a.role,a.room_ids_json,a.permissions_json FROM encounters e JOIN rooms r ON r.room_id=e.room_id
      JOIN sessions s ON s.session_id=? JOIN accounts a ON a.account_id=s.account_id WHERE e.encounter_id=?`).get(row.clinician_session_id,row.encounter_id);
    return Boolean(context && context.closed_at===null && context.checked_in_at!==null && context.revoked_at===null && time<context.expires_at &&
      context.active && context.role==='CLINICIAN' && context.account_id===row.clinician_id && context.clinician_id===row.clinician_id &&
      context.assigned===row.clinician_id && parseJSON(context.room_ids_json,8192).includes(context.room_id) &&
      (row.mode!=='BREAK_GLASS' || parseJSON(context.permissions_json,8192).includes('emergency:read')));
  }
  function requestState(row,time) {
    if(!pending(row.state)) return row.state;
    if(time>=row.expires_at) return 'EXPIRED';
    return contextLive(row,time)?row.state:'CANCELLED';
  }
  function grantState(row,time) {
    if(row.state!=='ACTIVE') return row.state;
    if(time>=row.expires_at) return 'EXPIRED';
    return contextLive(row,time)?'ACTIVE':'ENDED';
  }
  function settle(encounterId,time,actorId) {
    for(const row of db.prepare("SELECT * FROM consent_requests WHERE encounter_id=? AND state IN ('REQUESTED','CLARIFICATION_REQUESTED')").all(encounterId)) {
      const state=requestState(row,time);if(state===row.state) continue;
      db.prepare('UPDATE consent_requests SET state=?,end_reason=?,version=version+1 WHERE request_id=?').run(state,state,row.request_id);
      appendAudit(store,{actor_id:actorId,patient_id:row.patient_id,encounter_id:encounterId,operation:'CONSENT_REQUEST_ENDED',result:state,
        recorded_at:time,details:{request_id:row.request_id,reason_code:state}});
    }
    for(const row of db.prepare("SELECT * FROM encounter_grants WHERE encounter_id=? AND state='ACTIVE'").all(encounterId)) {
      const state=grantState(row,time);if(state==='ACTIVE') continue;
      db.prepare('UPDATE encounter_grants SET state=?,ended_at=?,end_reason=?,version=version+1 WHERE grant_id=?').run(state,time,state,row.grant_id);
      appendAudit(store,{actor_id:actorId,patient_id:row.patient_id,encounter_id:encounterId,operation:'CONSENT_ACCESS_ENDED',result:state,
        recorded_at:time,details:{grant_id:row.grant_id,reason_code:state}});
    }
  }
  function participant(ref,encounterId) {
    const ctx=auth.authenticate(ref),encounter=db.prepare('SELECT * FROM encounters WHERE encounter_id=?').get(encounterId);
    if(!encounter) fail('RESOURCE_UNAVAILABLE');
    if(ctx.actor.role==='PATIENT') {
      auth.ownPatient(ref,encounter.patient_id);if(!ctx.actor.permissions.includes('consent:decide')) fail('SCOPE_DENIED');
    } else if(ctx.actor.role==='CLINICIAN') auth.encounter(ref,encounterId,{permission:'queue:operate'});
    else auth.room(ref,encounter.room_id,'consent:assist');
    return {...ctx,encounter};
  }
  function clinician(ref,encounterId,permission='clinical:write') {
    const ctx=auth.encounter(ref,encounterId,{permission});if(ctx.actor.role!=='CLINICIAN') fail('SCOPE_DENIED');return ctx;
  }
  function requestFor(ctx,requestId) {
    const row=getRequest(requestId);
    if(!row || row.encounter_id!==ctx.encounter.encounter_id || (ctx.actor.role==='CLINICIAN' && row.clinician_session_id!==ctx.session.session_id)) fail('RESOURCE_UNAVAILABLE');
    return row;
  }
  function choice(ctx,body,requesterId) {
    if(body.approval_channel==='PHONE') {
      if(ctx.actor.role!=='PATIENT' || body.assistance!==undefined) fail('SCOPE_DENIED');
      return null;
    }
    if(ctx.actor.role!=='STAFF' || !ctx.actor.permissions.includes('consent:assist') || !body.assistance || ctx.actor.account_id===requesterId) fail('SCOPE_DENIED');
    return {assistant_id:ctx.actor.account_id,assistant_session_id:ctx.session.session_id,room_id:ctx.encounter.room_id,recorded_at:ctx.now,
      identity_check_method:'FICTIONAL_VISIT_DETAILS_CONFIRMED',...body.assistance};
  }
  function choiceDetails(ctx,body) {
    return {approval_channel:body.approval_channel,...(body.approval_channel==='ASSISTED_QR'?{
      assistant_session_id:ctx.session.session_id,identity_check_method:'FICTIONAL_VISIT_DETAILS_CONFIRMED'}:{})};
  }
  function open(ctx) {if(ctx.encounter.closed_at!==null || ctx.encounter.checked_in_at===null) fail('INVALID_TRANSITION');}
  function requestMetadata(row,changed=true) {
    return {status:row.state,changed,consent_request_id:row.request_id,encounter_id:row.encounter_id,patient_id:row.patient_id,
      request_version:row.version,request_state:row.state,request_expires_at:iso(row.expires_at)};
  }
  function grantMetadata(row,changed=true) {
    return {status:row.mode==='BREAK_GLASS'?'BREAK_GLASS':'ALLOWED',changed,grant_id:row.grant_id,grant_version:row.version,
      grant_state:row.state,mode:row.mode,issued_at:iso(row.issued_at),expires_at:iso(row.expires_at),scopes:parseJSON(row.scopes_json,8192),
      authorization_event_id:row.authorization_event_id,patient_id:row.patient_id,encounter_id:row.encounter_id};
  }
  function issue(request,mode,time,auditId) {
    const session=db.prepare('SELECT expires_at FROM sessions WHERE session_id=?').get(request.clinician_session_id);
    const expires=Math.min(time+900000,session.expires_at);if(expires<=time) fail('SESSION_ENDED');
    const grantId=`tok_enc_${randomBytes(32).toString('base64url')}`;
    db.prepare(`INSERT INTO encounter_grants VALUES(?,?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,NULL,NULL,?,0)`)
      .run(grantId,mode==='BREAK_GLASS'?null:request.request_id,request.encounter_id,request.patient_id,request.clinician_id,
        request.clinician_session_id,request.facility_id,'OPD_CONSULTATION',request.scopes_json,mode,time,expires,auditId);
    return getGrant(grantId);
  }
  function statusInUnit(ctx,selectedRequestId) {
    const e=ctx.encounter,time=now(),own=ctx.actor.role==='CLINICIAN';
    const condition=own?' AND clinician_session_id=?':'';
    const args=own?[e.encounter_id,ctx.session.session_id]:[e.encounter_id];
    const latest=selectedRequestId?requestFor(ctx,selectedRequestId):db.prepare(`SELECT * FROM consent_requests WHERE encounter_id=?${condition} ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(...args);
    const pendingRows=db.prepare(`SELECT * FROM consent_requests WHERE encounter_id=?${condition} AND state IN ('REQUESTED','CLARIFICATION_REQUESTED') AND expires_at>? ORDER BY created_at,rowid`).all(...args,time);
    const grantRows=db.prepare(`SELECT * FROM encounter_grants WHERE encounter_id=?${condition} AND state='ACTIVE' AND expires_at>? ORDER BY issued_at,rowid`).all(...args,time);
    const requestView=row=>{
      const state=requestState(row,time);
      const why=db.prepare("SELECT json_extract(details_json,'$.reason') note FROM audit_events WHERE operation='CONSENT_ASK_WHY' AND json_extract(details_json,'$.request_id')=? ORDER BY audit_id DESC LIMIT 1").get(row.request_id);
      return {consent_request_id:row.request_id,request_state:state,request_version:row.version,created_at:iso(row.created_at),expires_at:iso(row.expires_at),
        purpose:row.purpose,explanation:row.explanation,clarification_note:why?.note ?? null,scopes:parseJSON(row.scopes_json,8192),
        allowed_actions:pending(state)?(ctx.actor.role==='CLINICIAN'?(state==='CLARIFICATION_REQUESTED' && ctx.actor.permissions.includes('clinical:write')?['CLARIFY']:[]):['ALLOW','DENY','ASK_WHY']):[],
        maximum_grant_seconds:Math.max(0,Math.min(900,Math.floor((db.prepare('SELECT expires_at FROM sessions WHERE session_id=?').get(row.clinician_session_id).expires_at-time)/1000))),
        remaining_seconds:pending(state)?Math.max(0,Math.ceil((row.expires_at-time)/1000)):0};
    };
    const grantView=row=>({...grantMetadata(row,false),grant_state:grantState(row,time),
      allowed_actions:grantState(row,time)==='ACTIVE' && ctx.actor.role!=='CLINICIAN'?['REVOKE']:[],
      expires_in_seconds:grantState(row,time)==='ACTIVE'?Math.max(0,Math.ceil((row.expires_at-time)/1000)):0});
    const latestGrant=latest?db.prepare('SELECT * FROM encounter_grants WHERE request_id=? ORDER BY issued_at DESC,rowid DESC LIMIT 1').get(latest.request_id):null;
    const activeGrants=grantRows.filter(row=>grantState(row,time)==='ACTIVE');
    const doctor=db.prepare('SELECT username FROM accounts WHERE account_id=?').get(e.clinician_id);
    return {encounter_id:e.encounter_id,patient_id:e.patient_id,clinician:{account_id:e.clinician_id,display_name:`Fictional clinician (${doctor.username})`},
      facility:{facility_id:store.verification.facility_id,display_name:'Fictional demo facility'},purpose:'OPD_CONSULTATION',simulation_label:'FICTIONAL_CONSENT_WORKFLOW',
      decision_channel:ctx.actor.role==='PATIENT'?'PHONE':ctx.actor.role==='STAFF'?'ASSISTED_QR':null,
      request:latest?requestView(latest):null,grant:latestGrant?grantView(latestGrant):(activeGrants.length?grantView(activeGrants.at(-1)):null),
      pending_requests:pendingRows.filter(row=>pending(requestState(row,time))).map(requestView),active_grants:activeGrants.map(grantView),
      authorization_state:activeGrants.length?'ACTIVE':'LOCKED',clinical_data:null};
  }
  async function command(ref,intent,encounterId,kind) {
    if(['request','clarify','break-glass'].includes(kind)) intent={...intent,sessionBound:true};
    const body=intent.body;
    const authorize=()=>{
      const ctx=['request','clarify'].includes(kind)?clinician(ref,encounterId):kind==='break-glass'?clinician(ref,encounterId,'emergency:read'):participant(ref,encounterId);
      if(body.consent_request_id) {
        ctx.request=requestFor(ctx,body.consent_request_id);
        if(kind==='respond') choice(ctx,body,ctx.request.clinician_id);
      }
      if(body.replace_consent_request_id) requestFor(ctx,body.replace_consent_request_id);
      if(kind==='revoke') {
        ctx.grant=getGrant(body.grant_id);if(!ctx.grant || ctx.grant.encounter_id!==encounterId) fail('RESOURCE_UNAVAILABLE');
        choice(ctx,body,ctx.grant.clinician_id);
      }
      return ctx;
    };
    const result=await operations.executeCommand(ref,intent,authorize,ctx=>{
      if(kind==='request' || kind==='break-glass') open(ctx);
      settle(encounterId,ctx.now,ctx.actor.account_id);
      if(kind==='request') {
        const selected=scopes.filter(scope=>(body.scopes ?? defaultScopes).includes(scope)),scopeJson=canonicalJSON(selected);
        const active=db.prepare("SELECT * FROM encounter_grants WHERE encounter_id=? AND clinician_session_id=? AND state='ACTIVE'").get(encounterId,ctx.session.session_id);
        if(active) {
          if(active.scopes_json!==scopeJson || active.mode!=='PATIENT_APPROVED' || body.replace_consent_request_id) fail('INVALID_TRANSITION');
          return {...requestMetadata(getRequest(active.request_id),false),...grantMetadata(active,false)};
        }
        const previous=db.prepare("SELECT * FROM consent_requests WHERE encounter_id=? AND clinician_session_id=? AND state IN ('REQUESTED','CLARIFICATION_REQUESTED')").get(encounterId,ctx.session.session_id);
        if(previous && !body.replace_consent_request_id) {
          if(previous.scopes_json===scopeJson && previous.explanation===body.explanation) return requestMetadata(previous,false);
          fail('INVALID_TRANSITION');
        }
        if(body.replace_consent_request_id) {
          const replacement=requestFor(ctx,body.replace_consent_request_id);
          if(!pending(requestState(replacement,ctx.now))) fail('CONSENT_REQUEST_ENDED');
          if(replacement.version!==body.expected_request_version) fail('STATE_VERSION_CONFLICT');
          if(previous?.request_id!==replacement.request_id) fail('INVALID_TRANSITION');
          db.prepare("UPDATE consent_requests SET state='CANCELLED',end_reason='REPLACED',version=version+1 WHERE request_id=?").run(replacement.request_id);
          appendAudit(store,{actor_id:ctx.actor.account_id,patient_id:ctx.encounter.patient_id,encounter_id:encounterId,operation:'CONSENT_REQUEST_ENDED',result:'CANCELLED',
            recorded_at:ctx.now,details:{request_id:replacement.request_id,reason_code:'REPLACED'}});
        }
        const requestId=`consent_${randomUUID()}`;
        db.prepare(`INSERT INTO consent_requests VALUES(?,?,?,?,?,?,?, ?,?,'REQUESTED',?,?,0,NULL,NULL,NULL,NULL,NULL)`)
          .run(requestId,encounterId,ctx.encounter.patient_id,ctx.actor.account_id,ctx.session.session_id,store.verification.facility_id,
            'OPD_CONSULTATION',scopeJson,body.explanation,ctx.now,Math.min(ctx.now+300000,ctx.session.expires_at));
        return requestMetadata(getRequest(requestId));
      }
      if(kind==='respond' || kind==='clarify') {
        const request=getRequest(body.consent_request_id),state=requestState(request,ctx.now);
        if(['EXPIRED','CANCELLED'].includes(state)) fail('CONSENT_REQUEST_ENDED');
        if(request.version!==body.expected_request_version) fail('STATE_VERSION_CONFLICT');
        if(!pending(state)) fail('INVALID_TRANSITION');
        if(kind==='clarify') {
          if(state!=='CLARIFICATION_REQUESTED') fail('INVALID_TRANSITION');
          db.prepare("UPDATE consent_requests SET explanation=?,state='REQUESTED',version=version+1 WHERE request_id=?").run(body.explanation,request.request_id);
          return requestMetadata(getRequest(request.request_id));
        }
        const next={ALLOW:'ALLOWED',DENY:'DENIED',ASK_WHY:'CLARIFICATION_REQUESTED'}[body.action];
        const assistance=choice(ctx,body,request.clinician_id);
        db.prepare('UPDATE consent_requests SET state=?,decision_at=?,decision_actor_id=?,approval_channel=?,assistance_json=?,version=version+1 WHERE request_id=?')
          .run(next,ctx.now,ctx.actor.account_id,body.approval_channel,assistance?canonicalJSON(assistance):null,request.request_id);
        const updated=getRequest(request.request_id);
        if(body.action!=='ALLOW') return {...requestMetadata(updated),approval_channel:body.approval_channel};
        const existing=db.prepare("SELECT grant_id FROM encounter_grants WHERE encounter_id=? AND clinician_session_id=? AND state='ACTIVE'").get(encounterId,request.clinician_session_id);
        if(existing) fail('INVALID_TRANSITION');
        const auditId=appendAudit(store,{actor_id:ctx.actor.account_id,patient_id:request.patient_id,encounter_id:encounterId,operation:'CONSENT_ALLOW',result:'SUCCESS',
          recorded_at:ctx.now,details:{request_id:request.request_id,patient_choice:'ALLOW',mode:'PATIENT_APPROVED',scopes:parseJSON(request.scopes_json,8192),...choiceDetails(ctx,body)}});
        return {...requestMetadata(updated),...grantMetadata(issue(updated,'PATIENT_APPROVED',ctx.now,auditId)),approval_channel:body.approval_channel};
      }
      if(kind==='revoke') {
        const grant=getGrant(body.grant_id);if(grantState(grant,ctx.now)!=='ACTIVE') fail('GRANT_ENDED');
        if(grant.version!==body.expected_grant_version) fail('STATE_VERSION_CONFLICT');
        db.prepare("UPDATE encounter_grants SET state='REVOKED',ended_at=?,end_reason='PATIENT_REVOKED',version=version+1 WHERE grant_id=?").run(ctx.now,grant.grant_id);
        return {...grantMetadata(getGrant(grant.grant_id)),status:'REVOKED',approval_channel:body.approval_channel};
      }
      // The current server-owned registration is compared with this labelled fictional registry.
      const registry={clinician_12:'MOCK-NMC-12',clinician_18:'MOCK-NMC-18'};
      if(ctx.actor.registration_id!==registry[ctx.actor.account_id] || !registry[ctx.actor.account_id]) fail('SCOPE_DENIED');
      const active=db.prepare("SELECT * FROM encounter_grants WHERE encounter_id=? AND clinician_session_id=? AND state='ACTIVE'").get(encounterId,ctx.session.session_id);
      if(active) {if(active.mode!=='BREAK_GLASS') fail('INVALID_TRANSITION');return grantMetadata(active,false);}
      const request={encounter_id:encounterId,patient_id:ctx.encounter.patient_id,clinician_id:ctx.actor.account_id,clinician_session_id:ctx.session.session_id,
        facility_id:store.verification.facility_id,scopes_json:canonicalJSON(['triage:read','vault:query'])};
      const auditId=appendAudit(store,{actor_id:ctx.actor.account_id,patient_id:request.patient_id,encounter_id:encounterId,operation:'EMERGENCY_AUTHORIZATION',result:'SUCCESS',
        recorded_at:ctx.now,details:{reason:body.reason,mode:'BREAK_GLASS',scopes:['triage:read','vault:query'],reason_code:'SEEDED_MOCK_NOT_LIVE'}});
      return grantMetadata(issue(request,'BREAK_GLASS',ctx.now,auditId));
    },{audit:(ctx,outcome)=>({patient_id:ctx.encounter.patient_id,encounter_id:encounterId,operation:kind==='respond'?(body.action==='ALLOW'?'CONSENT_RESPOND':`CONSENT_${body.action}`):`CONSENT_${kind.replace('-','_').toUpperCase()}`,
      result:outcome.status,details:{...(outcome.consent_request_id?{request_id:outcome.consent_request_id}:{}),...(outcome.grant_id?{grant_id:outcome.grant_id}:{}),
        ...(kind==='respond'?{patient_choice:body.action,...choiceDetails(ctx,body),...(body.note?{reason:body.note}:{})}:{}),
        ...(kind==='revoke'?{patient_choice:'REVOKE',...choiceDetails(ctx,body),...(body.reason?{reason:body.reason}:{})}:{})}})});
    // Safe original outcome plus current effective metadata; an old ACTIVE receipt never revives access.
    try {return store.runUnit(false,()=>{
      const ctx=authorize(),grant=result.grant_id?getGrant(result.grant_id):null;
      return {...result,outcome:result.status,...(grant?{grant_state:grantState(grant,now()),expires_in_seconds:grantState(grant,now())==='ACTIVE'?Math.max(0,Math.ceil((grant.expires_at-now())/1000)):0}:{}),
        ...(kind==='break-glass'?{registry_check:'SEEDED_MOCK_NOT_LIVE'}:{}),allowance:statusInUnit(ctx,result.consent_request_id)};
    });} catch(error) {error.commit_state='UNKNOWN';throw error;}
  }
  async function recordEmergencyDenial(ref,encounterId,code) {
    try {
      await retryUnit(store,true,()=>{
        const ctx=auth.authenticate(ref);let e;
        try {e=auth.encounter(ref,encounterId).encounter;} catch { /* Do not disclose an unrelated object in the audit. */ }
        appendAudit(store,{actor_id:ctx.actor.account_id,patient_id:e?.patient_id ?? null,encounter_id:e?.encounter_id ?? null,
          operation:'EMERGENCY_REJECTED',result:'DENIED',recorded_at:now(),details:{reason_code:code}});
      });
    } catch(error) {if(!['AUTH_REQUIRED','SESSION_ENDED'].includes(error.code)) throw error;}
  }
  return {command,recordEmergencyDenial,participant,statusInUnit,
    status:(ref,encounterId)=>store.runUnit(false,()=>statusInUnit(participant(ref,encounterId))),
    endEncounterAccess:(encounterId,reason,time,actorId)=>endEncounterAccess(store,encounterId,reason,time,actorId)};
}
