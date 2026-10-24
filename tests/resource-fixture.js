import path from 'node:path';
import { copyFile,writeFile,mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { APP_ROOT } from '../backend/config.js';
import { loadFixtures,initializeDatabase } from '../backend/manage.js';
import { canonicalJSON,digest } from '../backend/services/vault.js';

export async function resourceFixture(directory) {
  const seed=structuredClone(loadFixtures().seed);
  seed.encounters=seed.encounters.filter(e=>!e.absent);
  const absent=seed.visits.find(v=>v.queue_state==='SKIPPED_ABSENT');absent.queue_state='WAITING';absent.queue_rank=2;
  const ranks={room_12:2,room_18:0};
  for(let index=5;index<=20;index+=1) {
    const room=index<=11?'room_12':'room_18';
    seed.patients.push({patient_id:`patient_resource_${index}`,display_name:`Fictional resource patient ${index}`,date_of_birth:null,language:'en',demo_identifier:null});
    seed.visits.push({visit_id:`visit_resource_${index}`,patient_id:`patient_resource_${index}`,token_id:`token_resource_${index}`,
      public_token:`OPD-${String(index).padStart(3,'0')}`,room_id:room,queue_state:'WAITING',queue_rank:++ranks[room]});
  }
  seed.next_token_number=21;
  const template=seed.clinical_events.find(e=>e.patient_id==='patient_demo_ledger');
  for(let sequence=3;sequence<=20;sequence+=1) seed.clinical_events.push({...structuredClone(template),event_id:`evt_resource_${sequence}`,
    sequence,entity_id:`entity_resource_${sequence}`,event_type:'CONDITION_RECORDED',
    payload:{concept:{text:'Dyspepsia',term_key:'dyspepsia_demo',coding:null},clinical_status:'UNKNOWN',verification_status:'UNCONFIRMED'}});
  const fixtures=path.join(directory,'fixtures');await mkdir(fixtures);
  for(const name of ['facility_map.json','mock_asr_outputs.json']) await copyFile(path.join(APP_ROOT,'data/fixtures',name),path.join(fixtures,name));
  await writeFile(path.join(fixtures,'seed.json'),JSON.stringify(seed));
  const passwords=Object.fromEntries(seed.accounts.map(a=>[a.username,randomBytes(24).toString('base64url')]));
  const db=path.join(directory,'resource.sqlite3');
  const initialized=await initializeDatabase(db,{passwords,fixtureDirectory:fixtures});
  return {db,passwords,fixture:'resource-small-v1',fixture_source_sha256:digest(canonicalJSON(seed)),
    counts:initialized.counts,heads:initialized.clinical_heads};
}
