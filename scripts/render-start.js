// Explicit deployment entrypoint; ordinary invocation never initializes storage.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadServerSettings,loadStorageSettings,resolveDatabasePath,isWithin,parsePublicApiBase } from '../backend/config.js';
import { StorageError,privatePath,requireStorage } from '../backend/db.js';
import { initializeDatabase,main as managementMain } from '../backend/manage.js';
import { parseJSON } from '../backend/services/vault.js';
import { startServer } from '../backend/server.js';
import { readPrivateFile } from '../backend/private-file.js';

export function deploymentCheck(settings,env,{diskRoot=path.join(settings.appRoot,'data/runtime')}={}) {
  requireStorage(settings.host==='0.0.0.0' && !settings.loopbackHttp,'DEPLOYMENT_HTTPS_REQUIRED');
  requireStorage(settings.frontendOrigin===settings.apiOrigin && parsePublicApiBase(env.PUBLIC_API_BASE_URL)==='/api/v1','DEPLOYMENT_SAME_ORIGIN_REQUIRED');
  requireStorage(isWithin(diskRoot,settings.dbPath) && settings.dbPath!==diskRoot,'DEPLOYMENT_DISK_PATH_REQUIRED');
  requireStorage(env.WEB_CONCURRENCY===undefined || env.WEB_CONCURRENCY==='1','DEPLOYMENT_SINGLE_PROCESS_REQUIRED');
  requireStorage(settings.mockAsr.valid && settings.mockAsr.enabled && settings.sarvam.valid,'DEPLOYMENT_MOCK_VOICE_REQUIRED');
  requireStorage(!settings.sarvam.requested||Boolean(settings.sarvam.apiKey),'DEPLOYMENT_AI_KEY_REQUIRED');
  return {status:'CONFIGURATION_VALID',storage:'PRIVATE_PERSISTENT_DISK_REQUIRED',origin:settings.apiOrigin,
    provider_calls:settings.sarvam.requested?'CREDIT_GATED':'DISABLED'};
}
export async function initializeDeployment(settings,secretFile=existsSync('/etc/secrets/vellum-passwords.json')?'/etc/secrets/vellum-passwords.json':
  existsSync('/etc/secrets/vaultmed-passwords.json')?'/etc/secrets/vaultmed-passwords.json':'/etc/secrets/vellum-passwords.json') {
  const file=privatePath(settings.dbPath,{createParents:true});
  requireStorage(!existsSync(file),'DEPLOYMENT_DATABASE_ALREADY_EXISTS');
  let bytes,passwords;
  try {
    try {bytes=readPrivateFile(secretFile,8192);}
    catch(error){throw new StorageError(`DEPLOYMENT_PASSWORD_${error.code?.startsWith('PRIVATE_FILE_')?error.code.slice(13):'FILE_UNREADABLE'}`);}
    let text;
    try {text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
    catch{throw new StorageError('DEPLOYMENT_PASSWORD_UTF8_INVALID');}
    try {passwords=parseJSON(text,8192);}
    catch{throw new StorageError('DEPLOYMENT_PASSWORD_JSON_INVALID');}
    let result;
    try {result=await initializeDatabase(file,{passwords,seedLabel:'opd-demo-v1'});}
    catch(error){if(error.code==='PRIVATE_PASSWORD_INPUT_REQUIRED')throw new StorageError('DEPLOYMENT_PASSWORD_VALUES_INVALID');throw error;}
    requireStorage(result.status==='INITIALIZED','DEPLOYMENT_DATABASE_ALREADY_EXISTS');
  }finally {bytes?.fill(0);passwords=null;}
}
export async function runDeployment(args=process.argv.slice(2),env=process.env) {
  const maintenance=args[0]==='--maintenance';
  requireStorage(maintenance?args.length>=2 && ['verify','backup','restore'].includes(args[1]):
    args.length===0 || args.length===1 && ['--check','--initialize-new'].includes(args[0]),'INVALID_COMMAND_OPTION');
  const settings=loadServerSettings(env),checked=deploymentCheck(settings,env);
  if(args[0]==='--check')return {configuration:checked}; // No storage creation/provider work.
  if(args[0]==='--initialize-new')await initializeDeployment(settings);
  if(maintenance)await deploymentMaintenance(args.slice(1),env);
  return startServer(settings,{shutdownGraceMs:25000}); // Leave room before Render's 30-second termination limit.
}
export async function deploymentMaintenance(args,env) {
  requireStorage(['verify','backup','restore'].includes(args[0]),'INVALID_COMMAND_OPTION');
  const {values}=parseArgs({args,allowPositionals:true,strict:true,options:{db:{type:'string'},out:{type:'string'},backup:{type:'string'},'new-db':{type:'string'}}});
  const configured=loadStorageSettings(env).dbPath;
  if(args[0]==='restore')requireStorage(typeof values['new-db']==='string' && resolveDatabasePath(values['new-db'])===configured,'DEPLOYMENT_RESTORE_TARGET_MISMATCH');
  else if(values.db!==undefined)requireStorage(resolveDatabasePath(values.db)===configured,'DEPLOYMENT_DATABASE_TARGET_MISMATCH');
  // Runtime disk is unavailable in Render's build/predeploy/one-off jobs. This explicit
  // command runs after the disk-backed old instance has stopped, before opening a listener.
  return managementMain(args,{env,output:()=>{}});
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {const result=await runDeployment();
    if(result.configuration)console.log(JSON.stringify(result.configuration));
    else {console.log('LISTENING: DEPLOYMENT');
      const stop=()=>result.close().catch(()=>{process.exitCode=1;});process.once('SIGINT',stop);process.once('SIGTERM',stop);}
  }catch(error){const code=/^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code??'')?error.code:'DEPLOYMENT_START_FAILED';
    console.error(JSON.stringify({error:code}));process.exitCode=1;}
}
