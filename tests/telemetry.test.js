import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetry,percentile95 } from '../backend/telemetry.js';
import { clinicalFixture,allow,ok,queryBody } from './clinical-helpers.js';

test('R07 metric arithmetic: bounded nearest-rank window, honest unavailable states and actual RSS input',()=>{
  let time=0;const metrics=createTelemetry({mono:()=>time,utc:()=>0,rss:()=>123456});
  assert.equal(metrics.snapshot(0).latency_p95_ms,null);assert.equal(metrics.snapshot(0).latency_reason,'INSUFFICIENT_SAMPLES');
  for(let n=1;n<=100;n+=1)metrics.recordQuery(n);
  assert.equal(metrics.snapshot(3).latency_p95_ms,95);assert.equal(metrics.snapshot(3).rss_bytes,123456);assert.equal(metrics.snapshot(3).ingestion_in_flight,3);
  for(let n=0;n<500;n+=1)metrics.recordQuery(10);assert.equal(metrics.snapshot(0).sample_count,256);
  time=300000;assert.equal(metrics.snapshot(0).sample_count,0);assert.equal(metrics.snapshot(0).latency_p95_ms,null);
  assert.equal(percentile95([]),null);assert.equal(percentile95([NaN]),null);assert.equal(percentile95([-1]),null);
  assert.equal(createTelemetry({rss:()=>{throw Error();}}).snapshot(0).rss_availability,'UNAVAILABLE');
});
test('R07 HTTP telemetry: staff/clinician only, public/error requests excluded, successful actual query measured',async t=>{
  const f=await clinicalFixture(t);
  assert.equal((await f.request('/api/v1/system/telemetry')).status,401);assert.equal((await f.patient.get('/api/v1/system/telemetry')).status,403);
  assert.equal(ok(await f.staff.get('/api/v1/system/telemetry')).sample_count,0);
  await f.request('/api/v1/queue/display/room_12');await f.doctor.post('/api/v1/vault/query',queryBody(f));
  assert.equal(ok(await f.staff.get('/api/v1/system/telemetry')).sample_count,0);
  await allow(f);ok(await f.doctor.post('/api/v1/vault/query',queryBody(f)));
  const state=ok(await f.staff.get('/api/v1/system/telemetry'));assert.equal(state.sample_count,1);assert.equal(state.latency_p95_ms,null);
  assert.equal(state.latency_basis,'SERVER_REQUEST');assert.equal(state.latency_operation,'VAULT_QUERY');assert.ok(state.rss_bytes>0);
  assert.ok(!JSON.stringify(state).includes('patient_demo'));
});
