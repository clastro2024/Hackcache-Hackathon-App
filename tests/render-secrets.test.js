import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,mkdir,symlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {readPrivateFile} from '../backend/private-file.js';
import {initializeDeployment} from '../scripts/render-start.js';
import {loadServerSettings} from '../backend/config.js';
import {fixture,ownedDirectory,removeOwned} from './helpers.js';

test('Render private files: bounded regular reads and safe non-content diagnostics',async t=>{
  const dir=await ownedDirectory();t.after(()=>removeOwned(dir));const file=path.join(dir,'input.json');
  assert.throws(()=>readPrivateFile(file,8),{code:'PRIVATE_FILE_MISSING'});
  await writeFile(file,'12345678');const bytes=readPrivateFile(file,8);assert.equal(bytes.toString(),'12345678');bytes.fill(0);
  await writeFile(file,'123456789');assert.throws(()=>readPrivateFile(file,8),{code:'PRIVATE_FILE_TOO_LARGE'});
  assert.throws(()=>readPrivateFile(dir,8),{code:'PRIVATE_FILE_NOT_REGULAR'});
});

test('Render projected secrets: only fixed mount entries follow links; ordinary linked files remain refused',
  {skip:process.platform==='win32'?'Linux Render mount boundary; exercised by Ubuntu CI':false},async t=>{
    const dir=await ownedDirectory();t.after(()=>removeOwned(dir));const mount=path.join(dir,'secrets');await mkdir(mount);
    const target=path.join(dir,'provider-owned-secret');await writeFile(target,'{"synthetic":true}');
    for(const name of ['vellum-passwords.json','vaultmed-passwords.json','sarvam-free-access.json']){
      const file=path.join(mount,name);await symlink(target,file);
      assert.equal(readPrivateFile(file,8192,{renderSecretDirectory:mount}).toString(),'{"synthetic":true}');
      assert.throws(()=>readPrivateFile(file,8192),{code:'PRIVATE_FILE_NOT_REGULAR'});
    }
    const other=path.join(mount,'other.json');await symlink(target,other);
    assert.throws(()=>readPrivateFile(other,8192,{renderSecretDirectory:mount}),{code:'PRIVATE_FILE_NOT_REGULAR'});
  });

test('Render bootstrap diagnostics distinguish file, JSON and password-policy failures before creating a dataset',async t=>{
  const f=await fixture(t),file=path.join(f.directory,'new.sqlite3'),secret=path.join(f.directory,'passwords.json');f.store.close();
  const settings=loadServerSettings({HOST:'0.0.0.0',FRONTEND_ORIGIN:'https://example.test',API_ORIGIN:'https://example.test',VAULTMED_DB_PATH:file});
  await assert.rejects(()=>initializeDeployment(settings,secret),{code:'DEPLOYMENT_PASSWORD_MISSING'});
  for(const [contents,code] of [
    ['x'.repeat(8193),'DEPLOYMENT_PASSWORD_TOO_LARGE'],
    ['```json\n{}\n```','DEPLOYMENT_PASSWORD_JSON_INVALID'],
    ['{"staff":"a","staff":"b"}','DEPLOYMENT_PASSWORD_JSON_INVALID'],
    [Buffer.from([0xff]),'DEPLOYMENT_PASSWORD_UTF8_INVALID'],
    ['{}','DEPLOYMENT_PASSWORD_VALUES_INVALID']
  ]){
    await writeFile(secret,contents);await assert.rejects(()=>initializeDeployment(settings,secret),{code});assert.equal(existsSync(file),false);
  }
});
