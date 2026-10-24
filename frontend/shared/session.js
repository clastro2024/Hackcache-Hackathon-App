import { api } from './api.js';

export function createSession(client=api,{now=Date.now,schedule=setTimeout,cancel=clearTimeout}={}) {
  let current=null,timer,pendingLogin=null;
  const listeners=new Set();
  function publish(value) {
    cancel(timer);current=value?.authenticated?value:null;client.setSession(value);
    if(current) timer=schedule(()=>client.clear('SESSION_EXPIRED'),Math.max(0,Date.parse(current.expires_at)-now()));
    for(const listener of listeners) listener(current);
    return current;
  }
  const unsubscribe=client.onContextClear(reason=>{
    if(['SESSION_ENDED','SESSION_EXPIRED','DATASET_CHANGED'].includes(reason)) {
      cancel(timer);current=null;for(const listener of listeners) listener(null);
    }
    if(reason==='DATASET_CHANGED') pendingLogin=null;
  });
  return {
    async recover(){return publish(await client.read('/auth/session'));},
    async signIn(username,password) {
      const normalized=username.trim().toLowerCase();
      const intent=client.createIntent('/auth/login',{username,password},pendingLogin?.username===normalized?{key:pendingLogin.key}:{});
      try {const result=await client.command(intent);pendingLogin=null;return publish(result);}
      catch(error) {
        pendingLogin=error.commit_state==='UNKNOWN' || error.retry_strategy==='SAME_KEY'?{username:normalized,key:intent.key}:null;
        throw error;
      }
      finally {client.forget(intent);} // Never retain credentials for later page actions.
    },
    async signOut() {
      const intent=client.createIntent('/auth/logout',{});
      const result=await client.command(intent);publish(result);return result;
    },
    get current(){return current;},
    subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
    dispose(){cancel(timer);unsubscribe();listeners.clear();current=null;pendingLogin=null;client.clear();},
  };
}
export const session=createSession();
