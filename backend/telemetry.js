// Bounded, process-local observations. Client HTTP measurements never populate this window.
export function percentile95(values) {
  if(!values.length || values.some(value=>!Number.isFinite(value)||value<0)) return null;
  return [...values].sort((a,b)=>a-b)[Math.ceil(values.length*0.95)-1];
}
export function createTelemetry({mono=()=>performance.now(),utc=Date.now,rss=()=>process.memoryUsage.rss()}={}) {
  let samples=[];
  function current() {const time=mono();samples=samples.filter(sample=>time-sample.at>=0 && time-sample.at<300000);return time;}
  return {
    recordQuery(duration){const at=current();if(!Number.isFinite(duration)||duration<0) return;
      samples.push({at,duration});if(samples.length>256) samples.shift();},
    snapshot(ingestion){current();let bytes=null;try {const value=rss();if(Number.isSafeInteger(value)&&value>0) bytes=value;}catch{}
      const sufficient=samples.length>=100;
      return {rss_bytes:bytes,rss_availability:bytes===null?'UNAVAILABLE':'AVAILABLE',rss_reason:bytes===null?'READ_FAILED':null,
        latency_p95_ms:sufficient?percentile95(samples.map(sample=>sample.duration)):null,
        latency_operation:'VAULT_QUERY',latency_basis:'SERVER_REQUEST',sample_count:samples.length,window_seconds:300,
        latency_availability:sufficient?'AVAILABLE':'UNAVAILABLE',latency_reason:sufficient?null:'INSUFFICIENT_SAMPLES',
        ingestion_in_flight:ingestion,measured_at:new Date(utc()).toISOString()};},
  };
}
