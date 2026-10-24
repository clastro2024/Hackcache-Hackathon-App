import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { emitKeypressEvents } from 'node:readline';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import argon2 from 'argon2';
import { z } from 'zod';
import { loadStorageSettings, APP_ROOT, PASSWORD_OPTIONS } from './config.js';
import { acquireLease, configureConnection, createStore, openDatabase, privatePath,
  requireStorage, schemaStatements, StorageError, verifyStorage } from './db.js';
import { eventSchema, draftPayloadSchemas, id, integer, date, hash, text } from './schemas.js';
import { appendAudit } from './services/audit.js';
import { appendEvents, canonicalJSON, parseJSON, verifyChains } from './services/vault.js';

const fixtureRoot = fileURLToPath(new URL('../data/fixtures/', import.meta.url));
const localized = z.strictObject({ en: text(500), hi: text(500) });
const mapSchema = z.strictObject({ fixture_schema_version: z.literal('facility-map-v1'), map_version: id,
  simulation_label: z.literal('FICTIONAL_SAMPLE_MAP_NOT_SURVEYED'),
  nodes: z.array(z.strictObject({ node_id: id, label: localized, floor: text(32) })).min(2).max(100),
  edges: z.array(z.strictObject({ from: id, to: id, step_free: z.boolean(), instructions: localized })).min(1).max(300) });
const seedSchema = z.strictObject({ fixture_schema_version: z.literal('opd-seed-v1'), seed_label: z.literal('opd-demo-v1'),
  simulation_label: z.literal('FICTIONAL_REHEARSAL_CHECKPOINT'), facility_id: id, map_version: id,
  next_token_number: integer.min(1), patients: z.array(z.strictObject({ patient_id: id, display_name: text(100),
    date_of_birth: date.nullable(), language: z.enum(['hi','en']), demo_identifier: text(32).nullable() })).min(1).max(20),
  accounts: z.array(z.strictObject({ account_id: id, username: z.string().regex(/^[a-z0-9-]{1,64}$/u),
    role: z.enum(['STAFF','CLINICIAN','PATIENT']), patient_id: id.nullable(), room_ids: z.array(id).max(10),
    permissions: z.array(text(64)).max(20), registration_id: text(64).nullable() })).min(3).max(30),
  rooms: z.array(z.strictObject({ room_id: id, label: text(100), floor: text(32), map_node: id, clinician_id: id })).min(1).max(10),
  visits: z.array(z.strictObject({ visit_id: id, patient_id: id, token_id: id, public_token: text(32), room_id: id,
    queue_state: z.enum(['IN_CONSULTATION','WAITING','SKIPPED_ABSENT']), queue_rank: integer.min(1).nullable() })).max(30),
  encounters: z.array(z.strictObject({ encounter_id: id, visit_id: id, patient_id: id, room_id: id, clinician_id: id,
    call_attempts: integer.min(1).max(3), checked_in_by: id.nullable(), absent: z.boolean() })).max(30),
  clinical_events: z.array(eventSchema).min(1).max(100) });
const asrSchema = z.strictObject({ fixture_schema_version: z.literal('mock-asr-fixtures-v1'),
  extractor_version: z.literal('mock-fixtures-v1'), fixtures: z.array(z.strictObject({ fixture_id: id, language: z.literal('hi'),
    script: z.literal('Latn'), text: text(12000), item_templates: z.array(z.strictObject({
      event_type: z.enum(['CONDITION_RECORDED','MEDICATION_RECORDED']), change_kind: z.enum(['INITIAL','CLINICAL_UPDATE']),
      source_kind: z.literal('CLINICIAN_ASSESSMENT'), quote: text(1000), payload: z.record(z.string(),z.json()),
    }).refine(item=>draftPayloadSchemas[item.event_type].safeParse(item.payload).success)).max(20),
    warning_codes: z.array(z.string().regex(/^[A-Z_]+$/u)).max(20) })).length(3) });

function readBounded(file,limit) {
  const stat=lstatSync(file);requireStorage(stat.isFile() && !stat.isSymbolicLink() && stat.size<=limit,'INVALID_FIXTURE');
  return parseJSON(readFileSync(file,'utf8'),limit);
}
function freeze(value) {
  if(value && typeof value==='object') {for(const child of Object.values(value)) freeze(child);Object.freeze(value);}
  return value;
}
export function loadRuntimeFixtures(directory=fixtureRoot) {
  let map;
  try {
    map = mapSchema.parse(readBounded(path.join(directory,'facility_map.json'),65536));
    const nodes = new Set(map.nodes.map(node => node.node_id));
    requireStorage(nodes.size === map.nodes.length && map.edges.every(edge => nodes.has(edge.from) && nodes.has(edge.to)), 'INVALID_FIXTURE');
  } catch { throw new StorageError('INVALID_FIXTURE'); }
  let mock;
  try {
    const registry = asrSchema.parse(readBounded(path.join(directory,'mock_asr_outputs.json'),65536));
    requireStorage(registry.fixtures.map(f => f.fixture_id).sort().join('|') ===
      'hindi_clip_1_dyspepsia|hindi_clip_2_bp_sugar|hindi_clip_3_scribe' &&
      registry.fixtures.every(f => f.item_templates.every(item => f.text.includes(item.quote))), 'INVALID_ASR_FIXTURE');
    mock = { available: true, registry };
  } catch { mock = { available: false, reason: 'INVALID_ASR_FIXTURE' }; }
  return freeze({ map, mock });
}
export function loadFixtures(directory=fixtureRoot) {
  const runtime=loadRuntimeFixtures(directory);
  let seed;
  try {
    seed=seedSchema.parse(readBounded(path.join(directory,'seed.json'),524288));
    const nodes=new Set(runtime.map.nodes.map(node=>node.node_id));
    requireStorage(seed.map_version===runtime.map.map_version && seed.rooms.every(room=>nodes.has(room.map_node)), 'INVALID_FIXTURE');
    for(const [items,key] of [[seed.patients,'patient_id'],[seed.accounts,'account_id'],[seed.accounts,'username'],
      [seed.rooms,'room_id'],[seed.visits,'visit_id'],[seed.encounters,'encounter_id']]) {
      requireStorage(new Set(items.map(item=>item[key])).size===items.length,'INVALID_FIXTURE');
    }
  } catch {throw new StorageError('INVALID_FIXTURE');}
  return freeze({seed,...runtime});
}

function passwordsFor(seed, passwords) {
  const shape = Object.fromEntries(seed.accounts.map(account => [account.username, text(128).min(12)]));
  try { return z.strictObject(shape).parse(passwords); } catch { throw new StorageError('PRIVATE_PASSWORD_INPUT_REQUIRED'); }
}
function reserve(file) { const handle = openSync(file,'wx',0o600); closeSync(handle); }

export async function initializeDatabase(value, { passwords, now = Date.now(), seedLabel = 'opd-demo-v1', fixtureDirectory } = {}) {
  const { seed, map, mock } = loadFixtures(fixtureDirectory);
  requireStorage(seedLabel === seed.seed_label, 'UNSUPPORTED_SEED');
  const file = privatePath(value, { createParents: true });
  if (existsSync(file)) {
    const store = openDatabase(file,{ verifyClinical: verifyChains, now });
    try {
      requireStorage(store.verification.facility_id === seed.facility_id && store.verification.map_version === map.map_version,'UNSUPPORTED_DATASET');
      return { status:'ALREADY_INITIALIZED', ...store.verification };
    } finally { store.close(); }
  }
  const secrets = passwordsFor(seed,passwords);
  const release = acquireLease(file);
  let store;
  try {
    const hashes = new Map();
    for (const account of seed.accounts) hashes.set(account.account_id,await argon2.hash(secrets[account.username],{...PASSWORD_OPTIONS,type:argon2.argon2id}));
    reserve(file);
    const db = new Database(file,{fileMustExist:true,timeout:50});
    store = createStore(db);
    configureConnection(db); db.pragma('journal_mode = WAL');
    store.runUnit(true, () => {
      for (const statement of schemaStatements) db.exec(statement);
      db.pragma('user_version = 1');
      db.prepare(`INSERT INTO schema_meta VALUES(1,1,?,?,?,?,?,?,NULL)`).run(
        `dataset_${randomUUID()}`,seed.facility_id,seed.seed_label,map.map_version,seed.next_token_number,now);
      for (const p of seed.patients) db.prepare('INSERT INTO patients VALUES(?,?,?,?,?,?)')
        .run(p.patient_id,p.display_name,p.date_of_birth,p.language,p.demo_identifier,now);
      for (const a of seed.accounts) db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?,?,?)').run(
        a.account_id,a.username,a.role,hashes.get(a.account_id),a.patient_id,canonicalJSON(a.room_ids),canonicalJSON(a.permissions),a.registration_id,1,now);
      for (const r of seed.rooms) db.prepare("INSERT INTO rooms VALUES(?,?,?,?,?,'ACTIVE',NULL,NULL,0)")
        .run(r.room_id,r.label,r.floor,r.map_node,r.clinician_id);
      for (const v of seed.visits) db.prepare('INSERT INTO visits VALUES(?,?,?,?,?,?,?,?,NULL,?)').run(
        v.visit_id,v.patient_id,v.token_id,v.public_token,v.room_id,v.queue_state,v.queue_rank,
        canonicalJSON({intake_mode:'MANUAL',simulation_label:seed.simulation_label}),now);
      for (const e of seed.encounters) db.prepare('INSERT INTO encounters VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
        e.encounter_id,e.visit_id,e.patient_id,e.room_id,e.clinician_id,now-(e.absent?300000:60000),e.call_attempts,
        now-(e.absent?200000:60000),e.absent?null:now-30000,e.checked_in_by,e.absent?now-150000:null,e.absent?'ABSENT':null);
      for (const patient of seed.patients) {
        // Source dates remain fictional source metadata; recording is this actual init action.
        // The standalone published byte vector stays a test reference, not a copied stored hash.
        const events = seed.clinical_events.filter(event => event.patient_id === patient.patient_id)
          .map(event=>({...event,recorded_at:new Date(now).toISOString()}));
        if (events.length) appendEvents(store,events,{fixtureSeed:true});
      }
      appendAudit(store,{actor_id:null,patient_id:null,encounter_id:null,operation:'DATASET_INITIALIZED',result:'SUCCESS',
        recorded_at:now,details:{seed_label:seed.seed_label,count:seed.clinical_events.length}});
    });
    return { status:'INITIALIZED', ...store.runUnit(false,() => ({...verifyStorage(db,{now}),clinical_heads:verifyChains(db)})),
      mock_asr_available:mock.available };
  } finally { if (store) store.close(); release(); }
}

export function verifyDatabase(value, { now = Date.now() } = {}) {
  const store = openDatabase(value,{verifyClinical:verifyChains,now});
  try { return {status:'VERIFIED',...store.verification}; } finally { store.close(); }
}

async function fileDigest(file) {
  const hashState = createHash('sha256');
  for await (const chunk of createReadStream(file,{highWaterMark:65536})) hashState.update(chunk);
  return hashState.digest('hex');
}
const manifestSchema = z.strictObject({ format:z.literal('vaultmed-backup-v1'),snapshot_at:z.iso.datetime(),
  sqlite_version:z.string().regex(/^\d+\.\d+\.\d+$/u),backup_sha256:hash,schema_version:z.literal(1),
  dataset_id:id,facility_id:id,seed_label:z.literal('opd-demo-v1'),map_version:id,
  counts:z.record(z.string(),integer),last_audit_id:integer,
  clinical_heads:z.array(z.strictObject({patient_id:id,checked_events:integer,head_hash:z.union([hash,z.literal('GENESIS')])})).max(1000) });

export async function backupDatabase(value, output, { now = Date.now() } = {}) {
  const file = privatePath(output,{createParents:true});
  requireStorage(!existsSync(file) && !existsSync(`${file}.manifest.json`),'DESTINATION_EXISTS');
  const source = openDatabase(value,{verifyClinical:verifyChains,now});
  let release, candidate;
  try {
    release = acquireLease(file); reserve(file);
    await source.db.backup(file);
    const db = new Database(file,{fileMustExist:true,timeout:50});
    candidate = createStore(db); configureConnection(db); db.pragma('journal_mode = DELETE');
    const verified = candidate.runUnit(false,() => ({...verifyStorage(db,{journal:'delete',now}),clinical_heads:verifyChains(db)}));
    const sqliteVersion = db.prepare('SELECT sqlite_version() version').get().version;
    candidate.close(); candidate = null;
    requireStorage(!existsSync(`${file}-wal`) && !existsSync(`${file}-shm`),'BACKUP_NOT_STANDALONE');
    const manifest = manifestSchema.parse({format:'vaultmed-backup-v1',snapshot_at:new Date(now).toISOString(),
      sqlite_version:sqliteVersion,backup_sha256:await fileDigest(file),...verified});
    writeFileSync(`${file}.manifest.json`,`${canonicalJSON(manifest)}\n`,{flag:'wx',mode:0o600});
    return {status:'BACKUP_VERIFIED',backup:path.relative(APP_ROOT,file),...manifest};
  } finally { if(candidate) candidate.close(); source.close(); if(release) release(); }
}

export async function restoreDatabase(backup, destination, { now = Date.now() } = {}) {
  const sourceFile = privatePath(backup,{existing:true});
  const file = privatePath(destination,{createParents:true});
  requireStorage(!existsSync(file),'DESTINATION_EXISTS');
  const manifestPath = privatePath(`${sourceFile}.manifest.json`,{existing:true});
  let manifest;
  try { manifest = manifestSchema.parse(readBounded(manifestPath,65536)); }
  catch { throw new StorageError('INVALID_BACKUP_MANIFEST'); }
  requireStorage(!['-wal','-shm','-journal'].some(suffix=>existsSync(`${sourceFile}${suffix}`)),'BACKUP_NOT_STANDALONE');
  requireStorage(await fileDigest(sourceFile) === manifest.backup_sha256,'BACKUP_CHECKSUM_MISMATCH');
  const source = openDatabase(sourceFile,{verifyClinical:verifyChains,journal:'delete',now});
  let release, target;
  try {
    requireStorage(await fileDigest(sourceFile) === manifest.backup_sha256,'BACKUP_CHECKSUM_MISMATCH');
    requireStorage(source.db.prepare('SELECT sqlite_version() version').get().version === manifest.sqlite_version,'BACKUP_RUNTIME_MISMATCH');
    const expected = {...manifest};
    for(const key of ['format','snapshot_at','sqlite_version','backup_sha256']) delete expected[key];
    requireStorage(canonicalJSON(expected) === canonicalJSON(source.verification),'BACKUP_METADATA_MISMATCH');
    release = acquireLease(file); reserve(file); await source.db.backup(file);
    const db = new Database(file,{fileMustExist:true,timeout:50}); target=createStore(db);
    configureConnection(db); db.pragma('journal_mode = WAL');
    const datasetId=`dataset_${randomUUID()}`;
    target.runUnit(true,() => {
      const sessions=db.prepare('UPDATE sessions SET revoked_at=? WHERE revoked_at IS NULL').run(now).changes;
      const requests=db.prepare("UPDATE consent_requests SET state='CANCELLED',end_reason='RESTORE',version=version+1 WHERE state IN ('REQUESTED','CLARIFICATION_REQUESTED')").run().changes;
      const grants=db.prepare("UPDATE encounter_grants SET state='ENDED',ended_at=?,end_reason='RESTORE',version=version+1 WHERE state='ACTIVE'").run(now).changes;
      db.prepare('UPDATE schema_meta SET dataset_id=?,restored_from_json=? WHERE singleton=1').run(datasetId,
        canonicalJSON({source_dataset_id:manifest.dataset_id,snapshot_at:manifest.snapshot_at,checkpoint_sha256:manifest.backup_sha256}));
      db.prepare("UPDATE rooms SET service_state='PAUSED_ON_BREAK',delay_reason='Recovered checkpoint: confirm current patients before resuming.',estimated_return_at=NULL,version=version+1").run();
      appendAudit(target,{actor_id:null,patient_id:null,encounter_id:null,operation:'DATASET_RESTORED',result:'SUCCESS',recorded_at:now,
        details:{source_dataset_id:manifest.dataset_id,dataset_id:datasetId,snapshot_at:manifest.snapshot_at,
          checkpoint_sha256:manifest.backup_sha256,ended_sessions:sessions,cancelled_requests:requests,ended_grants:grants}});
    });
    return {status:'RESTORED',requires_queue_reconciliation:true,snapshot_at:manifest.snapshot_at,
      ...target.runUnit(false,()=>({...verifyStorage(db,{now}),clinical_heads:verifyChains(db)}))};
  } finally { if(target) target.close(); source.close(); if(release) release(); }
}

export async function resetDatabase(value,newFile,{passwords,now=Date.now(),seedLabel='opd-demo-v1',backupOut}={}) {
  const destination=privatePath(newFile,{createParents:true});
  requireStorage(!existsSync(destination),'DESTINATION_EXISTS');
  requireStorage(seedLabel==='opd-demo-v1','UNSUPPORTED_SEED');
  passwordsFor(loadFixtures().seed,passwords);
  const backup=await backupDatabase(value,backupOut ?? `data/backups/reset-${randomUUID()}.sqlite3`,{now});
  const initialized=await initializeDatabase(destination,{passwords,now,seedLabel});
  return {...initialized,status:'RESET_TO_NEW_DATASET',previous_checkpoint:backup.backup};
}

async function hiddenPassword(username) {
  requireStorage(process.stdin.isTTY && typeof process.stdin.setRawMode === 'function','PRIVATE_PASSWORD_INPUT_REQUIRED');
  process.stderr.write(`Password for fictional account ${username} (12–128 characters): `);
  const prior=Boolean(process.stdin.isRaw); emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
  try {
    return await new Promise((resolve,reject)=>{
      let password='';
      const onKey=(str,key={})=>{
        if(key.ctrl && key.name==='c') { cleanup(); reject(new StorageError('INPUT_CANCELLED')); }
        else if(key.name==='return' || key.name==='enter') {cleanup();resolve(password);}
        else if(key.name==='backspace') password=[...password].slice(0,-1).join('');
        else if(!key.ctrl && !key.meta && typeof str==='string' && password.length+str.length<=128) password+=str;
      };
      const cleanup=()=>process.stdin.off('keypress',onKey);
      process.stdin.on('keypress',onKey);
    });
  } finally {process.stdin.setRawMode(prior);process.stdin.pause();process.stderr.write('\n');}
}
async function privatePasswords(stdinMode) {
  if(stdinMode) {
    let bytes=0; const chunks=[];
    for await(const chunk of process.stdin) {
      bytes+=chunk.length; requireStorage(bytes<=8192,'INVALID_PRIVATE_INPUT');chunks.push(chunk);
    }
    try {return parseJSON(Buffer.concat(chunks).toString('utf8'),8192);} catch {throw new StorageError('INVALID_PRIVATE_INPUT');}
  }
  const passwords={};
  for(const account of loadFixtures().seed.accounts) passwords[account.username]=await hiddenPassword(account.username);
  return passwords;
}

export async function main(args=process.argv.slice(2),{env=process.env,output=value=>console.log(JSON.stringify(value,null,2))}={}) {
  const parsed=parseArgs({args,allowPositionals:true,strict:true,options:{db:{type:'string'},seed:{type:'string'},
    out:{type:'string'},backup:{type:'string'},'new-db':{type:'string'},'passwords-stdin':{type:'boolean'},help:{type:'boolean',short:'h'}}});
  const options=parsed.values; const [command]=parsed.positionals;
  if(options.help) {console.log('npm run manage -- init|verify|backup|restore|reset [--db PATH] [--seed opd-demo-v1]\nbackup: --out PATH; restore: --backup PATH --new-db PATH; reset: --new-db PATH\nInitialization/reset prompts privately; --passwords-stdin accepts a private bounded JSON map. Stop the backend first.');return;}
  requireStorage(parsed.positionals.length===1 && ['init','verify','backup','restore','reset'].includes(command),'INVALID_COMMAND');
  const allowed={init:['db','seed','passwords-stdin'],verify:['db'],backup:['db','out'],restore:['backup','new-db'],
    reset:['db','new-db','seed','out','passwords-stdin']}[command];
  requireStorage(Object.keys(options).every(key=>allowed.includes(key)),'INVALID_COMMAND_OPTION');
  const db=command==='restore'?null:(options.db ?? loadStorageSettings(env).dbPath);
  const required=(key)=>{requireStorage(typeof options[key]==='string','MISSING_COMMAND_OPTION');return options[key];};
  let result;
  if(command==='verify') result=verifyDatabase(db);
  else if(command==='backup') result=await backupDatabase(db,required('out'));
  else if(command==='restore') result=await restoreDatabase(required('backup'),required('new-db'));
  else {
    // Matching init is harmless and needs no password re-entry.
    if(command==='init' && existsSync(privatePath(db))) result=await initializeDatabase(db,{seedLabel:options.seed});
    else {
      const destination=command==='reset'?required('new-db'):db;
      const passwords=await privatePasswords(options['passwords-stdin']);
      result=command==='init'?await initializeDatabase(db,{passwords,seedLabel:options.seed}):
        await resetDatabase(db,destination,{passwords,seedLabel:options.seed,backupOut:options.out});
    }
  }
  output(result);return result;
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {await main();} catch(error) {
    const code=error instanceof StorageError?error.code:'MAINTENANCE_FAILED';
    console.error(JSON.stringify({error:code,commit_state:error.commit_state ?? 'NOT_APPLICABLE'}));process.exitCode=1;
  }
}
