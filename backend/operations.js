import { types } from 'node:util';
import { retryUnit } from './db.js';
import { ApiError, receiptOutcomeSchema } from './schemas.js';
import { appendAudit, findReceipt, putReceipt, fingerprint } from './services/audit.js';

const promise=value=>value && typeof value.then==='function';
const sync=fn=>{if(typeof fn!=='function' || types.isAsyncFunction(fn)) throw new ApiError('INTERNAL_ERROR');};
export function createOperations(store,auth,{now,hooks={}}) {
  function keyFor(ctx,intent) {
    return {actor_id:ctx.actor.account_id,operation:`${intent.method} ${intent.path}`,idempotency_key:intent.key,
      request_fingerprint:fingerprint({method:intent.method,path:intent.path,body:intent.body})};
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
  return {executeCommand,readProtected};
}
