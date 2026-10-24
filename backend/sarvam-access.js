import { randomUUID } from 'node:crypto';
import { constants,openSync,closeSync,lstatSync,fstatSync,readSync,writeFileSync,renameSync,unlinkSync,existsSync } from 'node:fs';
import { z } from 'zod';
import { resolveSarvamAccessFile,SARVAM_RENDER_ACCESS_FILE } from './config.js';
import { privatePath,requireStorage } from './db.js';
import { timestamp } from './schemas.js';
import { parseJSON } from './services/vault.js';

const schema=z.strictObject({schema_version:z.literal('sarvam-free-access-v1'),operator_verified:z.literal(true),
  promotional_credit_remaining_inr:z.number().finite().positive(),verified_at:timestamp,expires_at:timestamp,no_paid_fallback:z.literal(true)});
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const validTime=(value,now)=>Date.parse(value.verified_at)<=now&&now<Date.parse(value.expires_at)&&
  Date.parse(value.expires_at)-Date.parse(value.verified_at)<=86400000;

// A manual confirmation, not a balance API. Read afresh at each provider admission.
export function creditStatus(now=Date.now(),filename) {
  let fd;
  try {
    const resolved=resolveSarvamAccessFile(filename);
    const file=resolved===SARVAM_RENDER_ACCESS_FILE?resolved:privatePath(resolved),stat=lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw Error('INVALID');
    fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const opened=fstatSync(fd);
    if(!opened.isFile()||!sameFile(opened,stat))throw Error('INVALID');
    const bytes=Buffer.alloc(4097);let length=0;
    try {
      while(length<bytes.length){const count=readSync(fd,bytes,length,bytes.length-length,length);if(!count)break;length+=count;}
      if(length>4096)throw Error('INVALID');
      const value=schema.parse(parseJSON(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length)),4096));
      if(!validTime(value,now))return {available:false,reason:'CREDIT_CONFIRMATION_EXPIRED_OR_FUTURE'};
      return {available:true,reason:null,verified_at:value.verified_at,expires_at:value.expires_at,
        operator_reported_credit_inr:value.promotional_credit_remaining_inr};
    }finally{bytes.fill(0);}
  }catch(error){return {available:false,reason:error.code==='ENOENT'?'CREDIT_CONFIRMATION_MISSING':'CREDIT_CONFIRMATION_INVALID'};}
  finally{if(fd!==undefined)closeSync(fd);}
}
export const freeAccess=(now=Date.now(),file)=>creditStatus(now,file).available;

export function writeCreditConfirmation({balance,verifiedAt,hours=24,replace=false},filename,now=Date.now()) {
  requireStorage(Number.isInteger(hours)&&hours>=1&&hours<=24,'INVALID_CREDIT_CONFIRMATION');
  let value;
  try {value=schema.parse({schema_version:'sarvam-free-access-v1',operator_verified:true,
    promotional_credit_remaining_inr:balance,verified_at:verifiedAt??new Date(now).toISOString(),
    expires_at:new Date(Date.parse(verifiedAt??new Date(now).toISOString())+hours*3600000).toISOString(),no_paid_fallback:true});}
  catch{requireStorage(false,'INVALID_CREDIT_CONFIRMATION');}
  requireStorage(validTime(value,now),'INVALID_CREDIT_CONFIRMATION');
  const resolved=resolveSarvamAccessFile(filename);requireStorage(resolved!==SARVAM_RENDER_ACCESS_FILE,'RENDER_SECRET_IS_READ_ONLY');
  const file=privatePath(resolved,{createParents:true});let prior;
  if(existsSync(file)){prior=lstatSync(file);requireStorage(prior.isFile()&&!prior.isSymbolicLink(),'INVALID_CREDIT_CONFIRMATION');
    requireStorage(replace,'CREDIT_CONFIRMATION_EXISTS');}
  const temporary=privatePath(`${file}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
    if(prior){requireStorage(sameFile(lstatSync(file),prior),'CREDIT_CONFIRMATION_CHANGED');renameSync(temporary,file);}
    else { // Exclusive creation prevents a concurrent operator file being overwritten.
      writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
    }
  }finally{if(existsSync(temporary))unlinkSync(temporary);}
  return {status:'CREDIT_CONFIRMATION_WRITTEN',verified_at:value.verified_at,expires_at:value.expires_at,
    operator_reported_credit_inr:balance,provider_calls:0};
}
export function sarvamStatus(settings,now=Date.now()) {
  const credit=creditStatus(now,settings.accessFile);
  const reason=!settings.valid?'CONFIGURATION_INVALID':!settings.requested?'DISABLED':!settings.apiKey?'KEY_MISSING':credit.reason;
  return {status:reason?'UNAVAILABLE':'READY',reason,model:'sarvam-105b',enabled:settings.requested,key_present:Boolean(settings.apiKey),
    credit_confirmation:credit,provider_calls:0};
}
