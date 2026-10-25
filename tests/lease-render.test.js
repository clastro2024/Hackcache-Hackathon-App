import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {acquireLease} from '../backend/db.js';
import {APP_ROOT} from '../backend/config.js';
import {ownedDirectory,removeOwned} from './helpers.js';

const linuxOnly={skip:process.platform==='linux'?false:'Render/Linux process identity is covered on Ubuntu CI'};
async function owned(t,instance='srv-test-current'){
  const directory=await ownedDirectory(),before={RENDER:process.env.RENDER,RENDER_INSTANCE_ID:process.env.RENDER_INSTANCE_ID};
  process.env.RENDER='true';process.env.RENDER_INSTANCE_ID=instance;
  t.after(async()=>{for(const [key,value]of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await removeOwned(directory);});
  const file=path.join(directory,'test.sqlite3');return {file,lock:`${file}.${instance}.lock`};
}

test('Render lease: unsafe instance identifiers fail before creating a lock',async t=>{
  const {file}=await owned(t,'../invalid');
  assert.throws(()=>acquireLease(file),{code:'INVALID_RUNTIME_INSTANCE'});assert.equal(existsSync(`${file}.lock`),false);
});

test('Render lease: new instance ignores prior-instance/legacy PID files without deleting them',linuxOnly,async t=>{
  const {file,lock}=await owned(t),old=JSON.stringify({pid:process.pid,nonce:randomUUID()});
  await writeFile(`${file}.lock`,old);await writeFile(`${file}.srv-test-old.lock`,old);
  const release=acquireLease(file);try{
    const value=JSON.parse(await readFile(lock,'utf8'));assert.equal(value.pid,process.pid);assert.match(value.identity.start_ticks,/^\d+$/u);
    assert.throws(()=>acquireLease(file),{code:'MAINTENANCE_LOCKED'});
    assert.equal(await readFile(`${file}.lock`,'utf8'),old);assert.equal(await readFile(`${file}.srv-test-old.lock`,'utf8'),old);
  }finally{release();}
  assert.equal(existsSync(lock),false);
});

test('Render lease: reused live PID is recovered only when Linux process identity differs',linuxOnly,async t=>{
  const {file,lock}=await owned(t);const initial=acquireLease(file),prior=JSON.parse(await readFile(lock,'utf8'));initial();
  await writeFile(lock,JSON.stringify({...prior,identity:{...prior.identity,start_ticks:'0'}}));
  const recovered=acquireLease(file);try{assert.throws(()=>acquireLease(file),{code:'MAINTENANCE_LOCKED'});}finally{recovered();}
  const unknown=JSON.stringify({pid:process.pid,nonce:randomUUID()});await writeFile(lock,unknown);
  assert.throws(()=>acquireLease(file),{code:'MAINTENANCE_LOCKED'});assert.equal(await readFile(lock,'utf8'),unknown);
});

test('Render lease: actual live child owner blocks another process in the same instance',linuxOnly,async t=>{
  const {file,lock}=await owned(t);
  const code=`import {acquireLease} from ${JSON.stringify(pathToFileURL(path.join(APP_ROOT,'backend/db.js')).href)};const release=acquireLease(process.argv[1]);console.log('READY');process.stdin.once('data',()=>{release();process.exit(0);});`;
  const child=spawn(process.execPath,['--input-type=module','-e',code,file],{env:{...process.env},windowsHide:true,stdio:['pipe','pipe','pipe']});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  try{
    await Promise.race([new Promise((resolve,reject)=>{child.stdout.once('data',data=>data.toString().includes('READY')?resolve():reject(new Error('Owned lease child not ready')));child.once('error',reject);}),exited.then(()=>{throw new Error('Owned lease child exited before readiness');})]);
    const before=await readFile(lock,'utf8');assert.throws(()=>acquireLease(file),{code:'MAINTENANCE_LOCKED'});assert.equal(await readFile(lock,'utf8'),before);
  }finally{if(child.exitCode===null){child.stdin.write('release\n');await exited;}}
  const release=acquireLease(file);release();assert.equal(existsSync(lock),false);
});
