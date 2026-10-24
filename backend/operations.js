import { types } from 'node:util';
import { randomUUID } from 'node:crypto';
import { retryUnit } from './db.js';
import { ApiError, receiptOutcomeSchema } from './schemas.js';
import { appendAudit, findReceipt, putReceipt, fingerprint, auditSnapshot, patientAuditHead, patientIntegrity } from './services/audit.js';
import { canonicalJSON, digest } from './services/vault.js';

const promise=value=>value && typeof value.then==='function';
const sync=fn=>{if(typeof fn!=='function' || types.isAsyncFunction(fn)) throw new ApiError('INTERNAL_ERROR');};
export function createOperations(store,auth,{now,hooks={}}) {
  let activeAI=null;
  function keyFor(ctx,intent) {
    return {actor_id:ctx.actor.account_id,operation:`${intent.method} ${intent.path}`,idempotency_key:intent.key,
      request_fingerprint:fingerprint({method:intent.method,path:intent.path,body:intent.body,
        ...(intent.sessionBound?{clinician_session_id:ctx.session.session_id}:{})})};
  }
  function checked(ref,intent,authorize) {
    const ctx=auth.authenticate(ref);
    if(intent?.method==='POST') auth.csrf(ctx,intent.csrf);
    const context=authorize(ctx);
    if(promise(context)) return context; // runUnit rejects/poisons the returned Promise.
    return {...ctx,...context};
  }
  async function executeCommand(ref,intent,authorize,apply,{audit}={}) {
    for(const fn of [authorize,apply,audit]) sync(fn);
    const result=await retryUnit(store,true,()=>{
      const ctx=checked(ref,intent,authorize);if(promise(ctx)) return ctx;
      const key=keyFor(ctx,intent);const receipt=findReceipt(store,key);
      if(receipt) return {...receipt.outcome,replayed:true};
      const applied=apply(ctx);if(promise(applied)) return applied;
      const safe=receiptOutcomeSchema.parse({...applied,committed_at:new Date(now()).toISOString()});
      const entry=audit(ctx,safe);if(promise(entry)) return entry;
      appendAudit(store,{...entry,actor_id:ctx.actor.account_id,recorded_at:now()});
      putReceipt(store,key,safe,now());return {...safe,replayed:false};
    });
    if(hooks.afterCommandCommit) {
      try {await hooks.afterCommandCommit();} catch {throw new ApiError('COMMIT_OUTCOME_UNKNOWN',{commitState:'UNKNOWN'});}
    }
    return result;
  }
  async function readProtected(ref,{intent,authorize,capture,compute,recheck,audit,maxBytes}) {
    for(const fn of [authorize,capture,recheck,audit]) sync(fn);
    if(!Number.isSafeInteger(maxBytes) || maxBytes<1 || typeof compute!=='function') throw new ApiError('INTERNAL_ERROR');
    for(let pass=0;pass<2;pass+=1) {
      const snapshot=store.runUnit(false,()=>{
        const ctx=checked(ref,intent,authorize);if(promise(ctx)) return ctx;
        const receipt=intent?findReceipt(store,keyFor(ctx,intent)):null;
        const selected=capture(ctx,receipt?.outcome);if(promise(selected)) return selected;
        return selected;
      });
      const body=await compute(snapshot.source);
      const buffer=Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body),'utf8');
      if(buffer.length>maxBytes) throw new ApiError('PAYLOAD_TOO_LARGE');
      if(hooks.beforeProtectedRelease) await hooks.beforeProtectedRelease();
      const final=await retryUnit(store,true,()=>{
        const ctx=checked(ref,intent,authorize);if(promise(ctx)) return ctx;
        const verified=recheck(ctx,snapshot);if(promise(verified)) return verified;
        if(intent) {
          const key=keyFor(ctx,intent);const receipt=findReceipt(store,key);
          if(receipt && fingerprint(receipt.outcome)!==fingerprint(snapshot.outcome)) return {winnerChanged:true};
          if(!receipt) putReceipt(store,key,snapshot.outcome,now());
        }
        const entry=audit(ctx,snapshot);if(promise(entry)) return entry;
        appendAudit(store,{...entry,actor_id:ctx.actor.account_id,recorded_at:now()});return {winnerChanged:false};
      });
      if(final.winnerChanged) continue;
      let released=false;
      return {release(){
        if(released) throw new ApiError('INVALID_TRANSITION');
        store.runUnit(false,()=>{
          const ctx=checked(ref,intent,authorize);if(promise(ctx)) return ctx;
          return recheck(ctx,snapshot);
        });
        released=true;return buffer;
      }};
    }
    throw new ApiError('IDEMPOTENCY_CONFLICT');
  }
  async function auditHistory(ref,patientId,query) {
    auth.admitSensitive(ref);
    return readProtected(ref,{authorize:()=>auth.ownPatient(ref,patientId),maxBytes:1048576,
      capture:()=>{
        const head=patientAuditHead(store,patientId),through=query.through_audit_id ?? head;
        if(through>head || query.after_audit_id>through) throw new ApiError('VALIDATION_ERROR');
        const rows=auditSnapshot(store,patientId,{through,after:query.after_audit_id,limit:query.limit});
        const last=rows.at(-1)?.audit_id;
        const more=last!==undefined && Boolean(store.db.prepare('SELECT 1 FROM audit_events WHERE patient_id=? AND audit_id>? AND audit_id<=? LIMIT 1').get(patientId,last,through));
        return {source:{patient_id:patientId,through_audit_id:through,audit_events:rows,next_after_audit_id:more?last:null},through,
          hash:digest(canonicalJSON(rows))};
      },compute:source=>source,
      recheck:(_ctx,snapshot)=>{
        const rows=auditSnapshot(store,patientId,{through:snapshot.through,after:query.after_audit_id,limit:query.limit});
        if(digest(canonicalJSON(rows))!==snapshot.hash) throw new ApiError('OUTPUT_CONTEXT_CHANGED');
      },audit:(_ctx,snapshot)=>({patient_id:patientId,encounter_id:null,operation:'AUDIT_HISTORY',result:'AUTHORIZED',details:{through_audit_id:snapshot.through}})});
  }
  async function integrity(ref,patientId) {
    auth.admitSensitive(ref);
    return readProtected(ref,{authorize:()=>auth.ownPatient(ref,patientId),maxBytes:8192,
      capture:()=>({source:patientIntegrity(store,patientId,now())}),compute:source=>source,
      recheck:(_ctx,snapshot)=>{
        const current=patientIntegrity(store,patientId,now());
        const stable=value=>({...value,verified_at:null});
        if(fingerprint(stable(current))!==fingerprint(stable(snapshot.source))) throw new ApiError('OUTPUT_CONTEXT_CHANGED');
      },audit:(_ctx,snapshot)=>({patient_id:patientId,encounter_id:null,operation:'INTEGRITY_CHECK',result:snapshot.source.status,
        details:{as_of_sequence:snapshot.source.checked_through_sequence}})});
  }
  async function exportOwnAudit(ref,patientId) {
    auth.admitSensitive(ref);store.runUnit(false,()=>auth.ownPatient(ref,patientId));
    const generationId=randomUUID();
    if(hooks.beforeAuditExport) await hooks.beforeAuditExport();
    // This specialized final unit includes every intervening matched row and its own release audit.
    const snapshot=await retryUnit(store,true,()=>{
      const ctx=auth.ownPatient(ref,patientId),chain=patientIntegrity(store,patientId,now());
      const through=appendAudit(store,{actor_id:ctx.actor.account_id,patient_id:patientId,encounter_id:null,
        operation:'AUDIT_EXPORT',result:'AUTHORIZED',recorded_at:now(),details:{generation_id:generationId,as_of_sequence:chain.checked_through_sequence}});
      const dataset=store.db.prepare('SELECT dataset_id FROM schema_meta WHERE singleton=1').get();
      return {audit_export_schema_version:'patient-audit-v1',patient_id:patientId,dataset_id:dataset.dataset_id,generation_id:generationId,
        generated_at:new Date(now()).toISOString(),through_audit_id:through,complete_through_bound:true,
        audit_events:auditSnapshot(store,patientId,{through}),chain_check:chain,
        checksum_limitation:'SHA-256 checks these exported bytes; it is not a signature or an independent authenticity anchor.'};
    });
    if(hooks.afterAuditExportCommit) await hooks.afterAuditExportCommit();
    const canonical=canonicalJSON(snapshot),hash=digest(canonical);
    const buffer=Buffer.from(`{"content":${canonical},"sha256":"${hash}"}`,'utf8');
    if(buffer.length>1048576) throw new ApiError('EXPORT_TOO_LARGE');
    let released=false;
    return {generationId,release(){
      if(released) throw new ApiError('INVALID_TRANSITION');store.runUnit(false,()=>auth.ownPatient(ref,patientId));
      released=true;return buffer;
    }};
  }
  function checkAIReservation(ctx,intent,task,key) {
    const reserved=store.db.prepare("SELECT details_json FROM audit_events WHERE actor_id=? AND operation='AI_RESERVED' AND json_extract(details_json,'$.ai_task')=? AND json_extract(details_json,'$.idempotency_key')=? ORDER BY audit_id DESC LIMIT 1")
      .get(ctx.actor.account_id,task,intent.key);
    if(reserved){const saved=JSON.parse(reserved.details_json);if(saved.request_fingerprint!==key.request_fingerprint)throw new ApiError('IDEMPOTENCY_CONFLICT');
      throw new ApiError(activeAI===`${ctx.actor.account_id}:${task}:${intent.key}`?'AI_REQUEST_IN_PROGRESS':'AI_OUTCOME_UNKNOWN');}
  }
  async function runAI(ref,intent,task,{authorize,capture,perform,recheck,apply}) {
    const selectedIntent={...intent,sessionBound:true};
    const token=ctx=>keyFor(ctx,selectedIntent);
    function prior(ctx) {
      const key=token(ctx),receipt=findReceipt(store,key);if(receipt)return {outcome:receipt.outcome,replayed:true};
      checkAIReservation(ctx,intent,task,key);
      return null;
    }
    const early=store.runUnit(false,()=>{const ctx=checked(ref,selectedIntent,authorize);return prior(ctx);});if(early)return early;
    if(activeAI!==null)throw new ApiError('AI_BUSY',{retryAfter:1});
    const first=store.runUnit(false,()=>checked(ref,selectedIntent,authorize));
    activeAI=`${first.actor.account_id}:${task}:${intent.key}`;
    try {
      const reservation=await retryUnit(store,true,()=>{
        const ctx=checked(ref,selectedIntent,authorize),existing=prior(ctx);if(existing)return existing;
        const dataset=store.db.prepare('SELECT dataset_id FROM schema_meta WHERE singleton=1').get().dataset_id;
        const counts=store.db.prepare("SELECT COUNT(*) total,COALESCE(SUM(recorded_at>?),0) recent FROM audit_events WHERE operation='AI_RESERVED' AND json_extract(details_json,'$.dataset_id')=?").get(now()-60000,dataset);
        if(counts.total>=30)throw new ApiError('AI_BUDGET_EXHAUSTED');if(counts.recent>=3)throw new ApiError('AI_RATE_LIMITED',{retryAfter:60});
        const source=capture(ctx),key=token(ctx);
        appendAudit(store,{actor_id:ctx.actor.account_id,patient_id:ctx.encounter.patient_id,encounter_id:ctx.encounter.encounter_id,
          operation:'AI_RESERVED',result:'ATTEMPT_RESERVED',recorded_at:now(),details:{ai_task:task,idempotency_key:intent.key,request_fingerprint:key.request_fingerprint,
            dataset_id:dataset,provider:'SARVAM',model:'sarvam-105b'}});return {source};
      });
      if(reservation.outcome)return reservation;
      let generated,failure;
      try {generated=await perform(reservation.source);}catch(error){failure=error instanceof ApiError?error:new ApiError('AI_PROVIDER_UNAVAILABLE');}
      const outcome=await retryUnit(store,true,()=>{
        const ctx=checked(ref,selectedIntent,authorize),key=token(ctx);
        let value;
        if(failure)value={status:'AI_FAILED',changed:false,ai_status:'FAILED',ai_error_code:failure.code};
        else {recheck(ctx,reservation.source);value=apply(ctx,reservation.source,generated);}
        const safe=receiptOutcomeSchema.parse({...value,committed_at:new Date(now()).toISOString()});
        appendAudit(store,{actor_id:ctx.actor.account_id,patient_id:ctx.encounter.patient_id,encounter_id:ctx.encounter.encounter_id,
          operation:'AI_RESULT',result:failure?'FAILED':'COMPLETED',recorded_at:now(),details:{ai_task:task,
            ...(safe.generation?{generation_id:safe.generation.generation_id,usage:safe.generation.usage}:{}),...(safe.draft_id?{draft_id:safe.draft_id,version:safe.version}:{}),
            ...(failure?{reason_code:failure.code}:{}),provider:'SARVAM',model:'sarvam-105b'}});
        putReceipt(store,key,safe,now());return safe;
      });
      return {outcome,replayed:false};
    } finally {activeAI=null;}
  }
  function aiOutcome(ref,intent,authorize,task) {
    const selected={...intent,sessionBound:true};return store.runUnit(false,()=>{
      const ctx=checked(ref,selected,authorize),key=keyFor(ctx,selected),receipt=findReceipt(store,key);
      if(receipt)return receipt.outcome;checkAIReservation(ctx,intent,task,key);return null;
    });
  }
  return {executeCommand,readProtected,auditHistory,integrity,exportOwnAudit,runAI,aiOutcome,get aiInFlight(){return activeAI===null?0:1;}};
}
