import { API_BASE_URL } from './config.js';

export class RequestError extends Error {
  constructor(code,{status=0,retry_strategy='NONE',commit_state='NOT_APPLICABLE',request_id,intent}={}) {
    super(code);Object.assign(this,{code,status,retry_strategy,commit_state,request_id,intent});
  }
}

// Authorization and pending intents live only in this page's memory.
export function createApiClient({base=API_BASE_URL,fetcher=(...args)=>fetch(...args),uuid=()=>crypto.randomUUID(),
  clock=()=>performance.now(),random=Math.random,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  let csrf=null,dataset=null,sessionIdentity=null,epoch=0;
  const pending=new Map(),listeners=new Set();
  const notify=reason=>{for(const listener of listeners) listener(reason);};
  function invalidate(reason) {epoch+=1;pending.clear();notify(reason);}
  function route(path,query={}) {
    if(typeof path!=='string' || !/^\/[A-Za-z0-9_/-]+$/u.test(path) || path.includes('//') || path.includes('..')) throw new RequestError('INVALID_PATH');
    const entries=Object.entries(query);
    if(entries.length>10 || entries.some(([key,value])=>!/^[a-z_]+$/u.test(key) || !['string','number'].includes(typeof value))) throw new RequestError('INVALID_QUERY');
    const search=new URLSearchParams(entries).toString();if(search.length>2048) throw new RequestError('INVALID_QUERY');
    return `${base}${path}${search?`?${search}`:''}`;
  }
  function createIntent(path,body,{key=uuid()}={}) {
    route(path);
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(key)) throw new RequestError('INVALID_INTENT_KEY');
    if(pending.size>=20) throw new RequestError('PENDING_INTENT_LIMIT');
    const serialized=JSON.stringify(body);
    if(typeof serialized!=='string' || new TextEncoder().encode(serialized).length>65536) throw new RequestError('PAYLOAD_TOO_LARGE');
    const intent=Object.freeze({key,path});
    pending.set(intent,{body:serialized,epoch});return intent;
  }
  async function request(path,intent,query) {
    const state=intent?pending.get(intent):null;
    if(intent && (!state || state.epoch!==epoch)) throw new RequestError('INTENT_INVALIDATED');
    const started=clock(),requestEpoch=epoch;
    let lastError;
    for(let attempt=0;attempt<3;attempt+=1) {
      if(requestEpoch!==epoch) throw new RequestError('CONTEXT_CHANGED');
      if(attempt>0 && clock()-started>=5000) throw lastError;
      let response,body,error;
      try {
        response=await fetcher(route(path,query),{method:intent?'POST':'GET',credentials:'include',cache:'no-store',redirect:'error',
          headers:intent?{'Content-Type':'application/json','X-Idempotency-Key':intent.key,...(csrf?{'X-CSRF-Token':csrf}:{})}:{},
          ...(intent?{body:state.body}:{}),signal:AbortSignal.timeout(10000)});
        const nextDataset=response.headers.get('X-Dataset-ID');
        if(requestEpoch!==epoch) throw new RequestError('CONTEXT_CHANGED');
        if(nextDataset && dataset && nextDataset!==dataset) {
          dataset=nextDataset;csrf=null;sessionIdentity=null;invalidate('DATASET_CHANGED');throw new RequestError('DATASET_CHANGED');
        }
        if(nextDataset) dataset=nextDataset;
        body=await response.json();
        if(requestEpoch!==epoch) throw new RequestError('CONTEXT_CHANGED');
        if(response.ok) {if(intent) pending.delete(intent);return body;}
        error=new RequestError(/^[A-Z][A-Z0-9_]{0,63}$/u.test(body?.error ?? '')?body.error:'REQUEST_FAILED',{
          status:response.status,retry_strategy:body.retry_strategy,commit_state:body.commit_state,request_id:body.request_id,intent});
      } catch(cause) {
        if(cause instanceof RequestError) throw cause;
        notify('NETWORK_UNAVAILABLE');
        const malformed=cause instanceof SyntaxError;
        error=new RequestError(malformed?'INVALID_RESPONSE':'NETWORK_UNAVAILABLE',{
          status:malformed?(response?.status ?? 502):0,retry_strategy:intent && !malformed?'SAME_KEY':'NONE',commit_state:intent?'UNKNOWN':'NOT_APPLICABLE',intent});
      }
      if(response?.status===401 || error.retry_strategy==='REAUTHENTICATE') {
        csrf=null;sessionIdentity=null;invalidate('SESSION_ENDED');throw error;
      }
      const retryable=intent && (error.status===0 || (error.status===503 && error.retry_strategy==='SAME_KEY'));
      const retryAfter=response?.headers.get('Retry-After');
      const retryAfterMs=retryAfter && /^\d+$/u.test(retryAfter)?Number(retryAfter)*1000:0;
      const wait=Math.max(Math.floor(random()*(attempt===0?251:501)),retryAfterMs);
      if(!retryable || attempt===2 || clock()-started+wait>=5000) {
        if(intent && error.commit_state!=='UNKNOWN' && error.retry_strategy!=='SAME_KEY') pending.delete(intent);
        throw error;
      }
      lastError=error;
      await sleep(wait);
    }
  }
  return {createIntent,read:(path,query)=>request(path,undefined,query),command:intent=>request(intent.path,intent),
    forget:intent=>pending.delete(intent),clear(reason='SESSION_ENDED'){csrf=null;sessionIdentity=null;invalidate(reason);},
    setSession(value) {
      const identity=value?.authenticated?`${value.actor.account_id}:${value.csrf_token}`:null;
      if(identity!==sessionIdentity) {sessionIdentity=identity;invalidate('SESSION_CHANGED');}
      csrf=value?.authenticated?value.csrf_token:null;
    },
    onContextClear(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
    get pendingCount(){return pending.size;},get datasetId(){return dataset;},
  };
}
export const api=createApiClient();
