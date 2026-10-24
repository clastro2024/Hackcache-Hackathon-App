// Explicit private operator setup only: no database access and no provider calls.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadSarvamSettings } from '../backend/config.js';
import { requireStorage } from '../backend/db.js';
import { sarvamStatus,writeCreditConfirmation } from '../backend/sarvam-access.js';

export function sarvamSetup(args=process.argv.slice(2),env=process.env,now=Date.now()) {
  const {positionals,values}=parseArgs({args,allowPositionals:true,strict:true,options:{'balance-inr':{type:'string'},
    'verified-at':{type:'string'},hours:{type:'string'},replace:{type:'boolean'}}});
  requireStorage(positionals.length===1&&['status','credit'].includes(positionals[0]),'INVALID_COMMAND_OPTION');
  const settings=loadSarvamSettings(env);
  if(positionals[0]==='status'){requireStorage(Object.keys(values).length===0,'INVALID_COMMAND_OPTION');return sarvamStatus(settings,now);}
  requireStorage(typeof values['balance-inr']==='string'&&/^\d+(?:\.\d+)?$/u.test(values['balance-inr'])&&
    (values.hours===undefined||/^\d+$/u.test(values.hours)),'INVALID_CREDIT_CONFIRMATION');
  return writeCreditConfirmation({balance:Number(values['balance-inr']),verifiedAt:values['verified-at'],
    hours:values.hours===undefined?24:Number(values.hours),replace:values.replace??false},settings.accessFile,now);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{console.log(JSON.stringify(sarvamSetup()));}
  catch(error){console.error(JSON.stringify({error:/^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code??'')?error.code:'AI_SETUP_FAILED'}));process.exitCode=1;}
}
