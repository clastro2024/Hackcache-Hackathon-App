import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eventSchema } from '../backend/schemas.js';
import { canonicalJSON, canonicalMatches, eventHash, parseJSON } from '../backend/services/vault.js';
import { loadFixtures } from '../backend/manage.js';

test('D12/C07 storage scope: Python-reference v1 bytes, Unicode, floats and published hash',()=>{
  const {vectors}=JSON.parse(readFileSync(new URL('./fixtures/v1-vectors.json',import.meta.url),'utf8'));
  for(const vector of vectors) {
    const event=eventSchema.parse(vector.event);const canonical=canonicalJSON(event);
    assert.equal(canonical,vector.canonical,vector.name);
    assert.equal(canonicalMatches(event,vector.canonical),true,vector.name);
    assert.equal(canonicalMatches(event,`${vector.canonical} `),false,vector.name);
    assert.equal(Buffer.byteLength(canonical),vector.utf8_length,vector.name);
    assert.equal(eventHash('GENESIS',canonical),vector.event_hash,vector.name);
    assert.equal(canonicalJSON(eventSchema.parse(parseJSON(canonical))),canonical);
  }
});
test('D12 storage scope: duplicate/non-finite/unsafe/deep JSON and unsupported values rejected',()=>{
  for(const json of ['{"a":1,"a":2}','{"a":{"b":1,"b":2}}','{"__proto__":1,"__proto__":2}',
    '{"a":1,"\\u0061":2}','{"x":NaN}','{"x":1e999}',
    '{"x":9007199254740993}','[1,]','{"a":1,}','[1] trailing','['.repeat(34)+'0'+']'.repeat(34)]) {
    assert.throws(()=>parseJSON(json),error=>error.code==='INVALID_JSON');
  }
  for(const value of [undefined,NaN,Infinity,new Date(),{a:undefined},'\ud800',Array(2)]) assert.throws(()=>canonicalJSON(value));
});

test('D12/C07 token comparison rejects equivalent noncanonical text, truncation and invalid values',()=>{
  const value={z:'हिंदी 😀',a:[true,null,-0,{capture:{confidence:1}}],capture:{confidence:1}};
  const canonical='{"a":[true,null,-0.0,{"capture":{"confidence":1}}],"capture":{"confidence":1.0},"z":"हिंदी 😀"}';
  assert.equal(canonicalJSON(value),canonical);assert.equal(canonicalMatches(value,canonical),true);
  for(const text of [null,'',canonical.slice(0,-1),` ${canonical}`,`${canonical}null`,canonical.replace('1.0','1'),
    canonical.replace('-0.0','0.0'),canonical.replace('true','true '),canonical.replace('😀','\\ud83d\\ude00'),
    '{"b":2,"a":1}'])assert.equal(canonicalMatches(value,text),false);
  assert.equal(canonicalMatches({a:1,b:2},'{"b":2,"a":1}'),false);
  assert.equal(canonicalMatches({'':{capture:{confidence:1}}},'{"":{"capture":{"confidence":1}}}'),true);
  for(const invalid of [undefined,NaN,Infinity,{a:undefined},'\ud800',Array(2)])assert.throws(()=>canonicalMatches(invalid,''));
  const parsed=parseJSON('{"__proto__":{"safe":true},"constructor":1}');
  assert.equal(Object.getPrototypeOf(parsed),null);assert.equal(parsed.__proto__.safe,true);assert.equal(parsed.constructor,1);
});
test('D12 canonical compatibility: code-point key ordering, prefixes, UTF-8 and confidence path bytes',()=>{
  assert.equal(canonicalJSON({'😀':2,'\ue000':1,'\u{10000}':3,aa:5,a:4}),'{"a":4,"aa":5,"\ue000":1,"\u{10000}":3,"😀":2}');
  assert.equal(canonicalJSON({capture:{confidence:1},other:1}),'{"capture":{"confidence":1.0},"other":1}');
  assert.equal(canonicalJSON({confidence:1},['capture']),'{"confidence":1.0}');
  assert.equal(canonicalJSON({'':{capture:{confidence:1}}}),'{"":{"capture":{"confidence":1}}}');
  assert.deepEqual({...parseJSON(' \t\r\n{"truth":true,"falsehood":false,"missing":null,"number":-1.25e2} ')},
    {truth:true,falsehood:false,missing:null,number:-125});
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
