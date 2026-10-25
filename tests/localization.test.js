import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hindiText,hindiDigits} from '../frontend/shared/hindi.js';
import {supportedQuestions} from '../backend/services/vault.js';

test('A11 Hindi presentation: token/room/timestamps and six question labels retain distinct canonical meanings',()=>{
  assert.equal(hindiText('OPD-001 · Room 12'),'ओपीडी-००१ · कक्ष १२');
  assert.equal(hindiText('Updated at 16:21, 25 Oct 2026'),'अंतिम अपडेट: १६:२१, २५ अक्टूबर २०२६');
  assert.equal(hindiText('2024-03-15'),'१५ मार्च २०२४');
  assert.equal(hindiText('Prescribed · Discontinued'),'निर्धारित दवा · बंद की गई');
  assert.equal(hindiText('Penicillin'),'पेनिसिलिन');
  assert.equal(hindiText('Token OPD-001'),'टोकन ओपीडी-००१');
  assert.equal(hindiText('Allergies'),'एलर्जी');
  assert.equal(hindiText('Fictional fixture · not clinically validated'),'काल्पनिक उदाहरण · चिकित्सकीय सत्यापन नहीं हुआ');
  const labels=supportedQuestions.map(hindiText);assert.equal(new Set(labels).size,6);assert.ok(labels.every(label=>!/[A-Za-z]/u.test(label)));
  for(const label of labels)assert.equal(supportedQuestions.filter(q=>q===label||hindiText(q)===label).length,1);
  assert.equal(new Set(['VERIFIED_POSITIVE','DOCUMENTED_NEGATIVE','NOT_RECORDED_IN_VAULT'].map(hindiText)).size,3);
});
test('C/D Hindi presentation: original source objects, unknown wording, technical IDs/hashes and units are preserved',()=>{
  const source={concept:'Penicillin',source_date:'2024-03-15',quote:'A newly reported, unclear source term',dose:'5 mg'};const bytes=JSON.stringify(source);
  for(const value of Object.values(source))hindiText(value);assert.equal(JSON.stringify(source),bytes);
  assert.equal(hindiText(source.quote),source.quote);assert.equal(hindiText('Fictional Patient A'),'Fictional Patient A');
  assert.equal(hindiDigits('a'.repeat(64)),'a'.repeat(64));assert.equal(hindiDigits('event_demo_123'),'event_demo_123');
  assert.equal(hindiDigits('https://example.test/123'),'https://example.test/123');assert.equal(hindiText('5 mg'),'५ मि.ग्रा.');
});
