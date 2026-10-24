import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eventSchema } from '../backend/schemas.js';
import { canonicalJSON, eventHash, parseJSON } from '../backend/services/vault.js';
import { loadFixtures } from '../backend/manage.js';

test('D12/C07 storage scope: Python-reference v1 bytes, Unicode, floats and published hash',()=>{
  const {vectors}=JSON.parse(readFileSync(new URL('./fixtures/v1-vectors.json',import.meta.url),'utf8'));
  for(const vector of vectors) {
    const event=eventSchema.parse(vector.event);const canonical=canonicalJSON(event);
    assert.equal(canonical,vector.canonical,vector.name);
    assert.equal(Buffer.byteLength(canonical),vector.utf8_length,vector.name);
    assert.equal(eventHash('GENESIS',canonical),vector.event_hash,vector.name);
    assert.equal(canonicalJSON(eventSchema.parse(parseJSON(canonical))),canonical);
  }
});
test('D12 storage scope: duplicate/non-finite/unsafe/deep JSON and unsupported values rejected',()=>{
  for(const json of ['{"a":1,"a":2}','{"a":{"b":1,"b":2}}','{"x":NaN}','{"x":1e999}',
    '{"x":9007199254740993}','[1,]','{"a":1,}','[1] trailing','['.repeat(34)+'0'+']'.repeat(34)]) {
    assert.throws(()=>parseJSON(json),error=>error.code==='INVALID_JSON');
  }
  for(const value of [undefined,NaN,Infinity,new Date(),{a:undefined},'\ud800',Array(2)]) assert.throws(()=>canonicalJSON(value));
});
test('C01/C02/C09 schema scope: six families, strict payloads and explicit source/review provenance',()=>{
  const original=loadFixtures().seed.clinical_events[0];
  const concept={text:'Fictional condition',term_key:null,coding:null};
  const examples=[
    original,
    {...original,event_type:'CONDITION_RECORDED',payload:{concept,clinical_status:'UNKNOWN',verification_status:'UNCONFIRMED'}},
    {...original,event_type:'ALLERGY_RECORDED',payload:{concept,clinical_status:'UNKNOWN',verification_status:'UNCONFIRMED',reaction_text:null,reaction_severity:'UNKNOWN'}},
    {...original,event_type:'PROCEDURE_RECORDED',payload:{concept,status:'REPORTED_COMPLETED',note:null}},
    loadFixtures().seed.clinical_events[2],
    {...original,event_type:'RECORD_RETRACTED',change_kind:'RETRACTION',change_reason:'Fictional error',supersedes_event_id:'evt_earlier',payload:{reason:'Fictional error'}},
  ];
  for(const event of examples) assert.equal(eventSchema.safeParse(event).success,true);
  assert.equal(eventSchema.safeParse({...original,extra:true}).success,false);
  assert.equal(eventSchema.safeParse({...original,event_type:'CONDITION_RECORDED'}).success,false);
  assert.equal(eventSchema.safeParse({...original,recorded_by:'clinician_12'}).success,false);
  const negative=structuredClone(examples[4]);delete negative.payload.clinical_basis;
  assert.equal(eventSchema.safeParse(negative).success,false);
});
test.todo('C acceptance remaining: authorized reviewed commit, entity projection, topic answers and clinical release');
