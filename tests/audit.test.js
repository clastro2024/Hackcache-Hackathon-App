import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clinicalFixture,ok,allow,encounter,patientId } from './clinical-helpers.js';
import { actorClient } from './helpers.js';
import { appendAudit } from '../backend/services/audit.js';
import { canonicalJSON,digest } from '../backend/services/vault.js';

const history=`/api/v1/audit/patient/${patientId}`;
const exportPath=`/api/v1/audit/export/${patientId}`;
const integrity=`/api/v1/audit/integrity-check/${patientId}`;

test('A/S audit HTTP: patient ownership on every page, fixed through bound, complete rows and no credential content',async t=>{
  const f=await clinicalFixture(t),other=await actorClient(f,'patient-b');await allow(f);
  for(const actor of [f.staff,f.doctor,other]) {
    for(const path of [history,exportPath,integrity]) assert.equal((await actor.get(path)).status,404);
  }
  const first=ok(await f.patient.get(`${history}?limit=1`));assert.equal(first.audit_events.length,1);
  const through=first.through_audit_id;let after=first.next_after_audit_id,rows=[...first.audit_events];
  while(after!==null) {
    const page=ok(await f.patient.get(`${history}?limit=1&through_audit_id=${through}&after_audit_id=${after}`));
    assert.equal(page.through_audit_id,through);rows.push(...page.audit_events);after=page.next_after_audit_id;
  }
  const expected=f.store.db.prepare('SELECT audit_id FROM audit_events WHERE patient_id=? AND audit_id<=? ORDER BY audit_id').all(patientId,through).map(row=>row.audit_id);
  assert.deepEqual(rows.map(row=>row.audit_id),expected);assert.ok(rows.every(row=>row.patient_id===patientId));
  for(const query of ['limit=101','after_audit_id=-1','through_audit_id=999999','limit=1&limit=2','patient_id=other']) assert.equal((await f.patient.get(`${history}?${query}`)).status,422);
  const body=JSON.stringify(rows);assert.ok(!body.includes(f.passwords['patient-a']));assert.ok(!body.includes(f.patient.login.body.csrf_token));assert.ok(!body.includes(f.patient.login.cookie));
});

test('D/S audit download HTTP: final fixed snapshot includes intervening own rows and the export audit; exact canonical UTF-8 checksum',async t=>{
  let before=null;
  const f=await clinicalFixture(t,{hooks:{beforeAuditExport(){before?.();}}});
  await allow(f);
  before=()=>f.store.runUnit(true,()=>{
    for(const [patient,reason] of [[patientId,'Intervening fictional action — हिंदी'],['patient_demo_negative','Other patient action must be excluded']]) {
      appendAudit(f.store,{actor_id:'staff_demo',patient_id:patient,encounter_id:null,operation:'TEST_INTERVENING',result:'RECORDED',recorded_at:Date.now(),details:{reason}});
    }
  });
  const result=await f.patient.get(exportPath);assert.equal(result.status,200,JSON.stringify(result.body));
  assert.match(result.headers.get('Content-Disposition'),/attachment; filename="vaultmed-audit-[a-f0-9-]+\.json"/u);
  const {content,sha256}=result.body;
  assert.equal(digest(Buffer.from(canonicalJSON(content),'utf8')),sha256);assert.equal(result.headers.get('X-Export-ID'),content.generation_id);
  assert.equal(content.complete_through_bound,true);assert.equal(content.chain_check.status,'PASS');assert.equal(content.audit_export_schema_version,'patient-audit-v1');
  assert.equal(content.audit_events.at(-1).operation,'AUDIT_EXPORT');assert.equal(content.audit_events.at(-1).audit_id,content.through_audit_id);
  assert.equal(content.audit_events.at(-1).details.generation_id,content.generation_id);
  assert.ok(content.audit_events.some(row=>row.operation==='TEST_INTERVENING'));assert.ok(!result.text.includes('Other patient action must be excluded'));
  const expected=f.store.db.prepare('SELECT audit_id FROM audit_events WHERE patient_id=? AND audit_id<=? ORDER BY audit_id').all(patientId,content.through_audit_id);
  assert.deepEqual(content.audit_events.map(row=>row.audit_id),expected.map(row=>row.audit_id));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE operation='AUDIT_EXPORT'").get().n,1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM clinical_events').get().n,3);
});

test('S audit download HTTP: logout after audit commit withholds the buffer without a second recursive export audit',async t=>{
  let after=null;
  const f=await clinicalFixture(t,{hooks:{async afterAuditExportCommit(){if(after){const fn=after;after=null;await fn();}}}});
  after=async()=>{ok(await f.patient.post('/api/v1/auth/logout',{}));};
  const result=await f.patient.get(exportPath);assert.equal(result.body.error,'SESSION_ENDED');assert.equal(result.body.content,undefined);
  assert.equal(result.headers.get('Content-Disposition'),null);assert.equal(result.body.sha256,undefined);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE operation='AUDIT_EXPORT'").get().n,1);
});

test('D/S audit download HTTP: audit failure and complete-output ceiling never return truncated dossiers',async t=>{
  const f=await clinicalFixture(t);
  f.store.db.exec("CREATE TRIGGER fail_audit_download BEFORE INSERT ON audit_events WHEN NEW.operation='AUDIT_EXPORT' BEGIN SELECT RAISE(ABORT,'test'); END");
  const failed=await f.patient.get(exportPath);assert.equal(failed.body.error,'AUDIT_UNAVAILABLE');assert.equal(failed.body.content,undefined);
  f.store.db.exec('DROP TRIGGER fail_audit_download');
  f.store.runUnit(true,()=>{for(let index=0;index<1100;index+=1) appendAudit(f.store,{actor_id:'staff_demo',patient_id:patientId,encounter_id:null,
    operation:'TEST_LARGE_AUDIT',result:'RECORDED',recorded_at:Date.now(),details:{reason:'x'.repeat(1000)}});});
  const tooLarge=await f.patient.get(exportPath);assert.equal(tooLarge.status,413);assert.equal(tooLarge.body.error,'EXPORT_TOO_LARGE');assert.equal(tooLarge.body.content,undefined);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM clinical_events').get().n,3);
  const page=ok(await f.patient.get(`${history}?limit=10`));assert.equal(page.audit_events.length,10);assert.notEqual(page.next_after_audit_id,null);
});

test('C07/S integrity HTTP: actual PASS/FAIL with safe first failure, and a damaged chain never becomes a false success',async t=>{
  const f=await clinicalFixture(t);
  const pass=ok(await f.patient.get(integrity));assert.equal(pass.status,'PASS');assert.equal(pass.ledger_format,'v1');assert.equal(pass.checked_through_sequence,2);
  f.store.db.exec('DROP TRIGGER clinical_no_update');
  f.store.db.prepare("UPDATE clinical_events SET event_hash=? WHERE event_id='evt_demo_stop'").run('b'.repeat(64));
  const failed=ok(await f.patient.get(integrity));assert.equal(failed.status,'FAIL');assert.equal(failed.first_failure_sequence,1);assert.equal(failed.checked_through_sequence,0);
  assert.equal(failed.reason_code,'CANONICAL_CHAIN_MISMATCH');assert.equal(failed.head_hash,null);assert.ok(!JSON.stringify(failed).includes('Ecosprin'));
  const dossier=ok(await f.patient.get(exportPath));assert.equal(dossier.content.chain_check.status,'FAIL');assert.equal(digest(canonicalJSON(dossier.content)),dossier.sha256);
});
