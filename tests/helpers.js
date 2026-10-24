import { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { APP_ROOT, isWithin, loadServerSettings } from '../backend/config.js';
import { createApp } from '../backend/app.js';
import { initializeDatabase, loadFixtures } from '../backend/manage.js';
import { openDatabase } from '../backend/db.js';
import { verifyChains } from '../backend/services/vault.js';

export const testPasswords = Object.fromEntries(loadFixtures().seed.accounts.map(a => [a.username,randomBytes(24).toString('base64url')]));
let template;
let templateDirectory;
export async function ownedDirectory() {
  const parent=path.join(APP_ROOT,'data/test-runs');await mkdir(parent,{recursive:true});
  assert.ok(!(await lstat(parent)).isSymbolicLink() && isWithin(APP_ROOT,await realpath(parent)));
  return mkdtemp(path.join(parent,'storage-'));
}
export async function removeOwned(directory) {
  const parent=path.join(APP_ROOT,'data/test-runs');
  assert.ok(directory!==parent && isWithin(parent,directory) && !(await lstat(directory)).isSymbolicLink() && isWithin(parent,await realpath(directory)));
  await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:50});
}
async function templateFile() {
  if(!template) template=(async()=>{
    templateDirectory=await ownedDirectory();const file=path.join(templateDirectory,'template.sqlite3');
    await initializeDatabase(file,{passwords:testPasswords});return file;
  })();
  return template;
}
after(async()=>{if(templateDirectory) await removeOwned(templateDirectory);});
export async function fixture(t) {
  const directory=await ownedDirectory();const file=path.join(directory,'test.sqlite3');
  const result={directory,file,store:null,passwords:testPasswords};
  t.after(async()=>{await result.cleanup?.();result.store?.close();await removeOwned(directory);});
  // Closed, checkpointed test template only; this is fixture setup, not a recovery test.
  await copyFile(await templateFile(),file);
  result.store=openDatabase(file,{verifyClinical:verifyChains});
  return result;
}

export async function httpFixture(t,options={}) {
  const {serverEnv={},...appOptions}=options;
  const f=await fixture(t);f.store.close();
  const origin='http://127.0.0.1:3000';
  const settings=loadServerSettings({FRONTEND_ORIGIN:origin,API_ORIGIN:origin,VAULTMED_DB_PATH:f.file,...serverEnv});
  const app=await createApp(settings,appOptions);f.store=app.locals.store;
  const server=http.createServer(app);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${server.address().port}`;
  f.cleanup=async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});app.locals.close();};
  async function request(route,{method='GET',cookie,csrf,key=randomUUID(),body,headers={}}={}) {
    const response=await fetch(`${base}${route}`,{method,headers:{...(method==='POST'?{'Content-Type':'application/json',Origin:origin,'X-Idempotency-Key':key}:{}),
      ...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...headers},...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
    const text=await response.text();let value;try{value=JSON.parse(text);}catch{value=text;}
    return {status:response.status,body:value,headers:response.headers,cookie:response.headers.get('Set-Cookie')?.split(';')[0],text};
  }
  async function login(username='doctor12',extra={}) {
    return request('/api/v1/auth/login',{method:'POST',body:{username,password:f.passwords[username]},...extra});
  }
  return {...f,app,server,base,origin,settings,request,login};
}

export async function actorClient(f,username='staff') {
  const login=await f.login(username);assert.equal(login.status,200,login.body.error);
  return {login,get:route=>f.request(route,{cookie:login.cookie}),
    post:(route,body,extra={})=>f.request(route,{method:'POST',cookie:login.cookie,csrf:login.body.csrf_token,body,...extra})};
}
