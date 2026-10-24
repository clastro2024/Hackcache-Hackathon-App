import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';
import { mkdir,mkdtemp,lstat,realpath,rm,writeFile,readFile,readdir } from 'node:fs/promises';
import { randomUUID,createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { APP_ROOT,isWithin } from '../backend/config.js';
import { privatePath } from '../backend/db.js';
import { resourceFixture } from './resource-fixture.js';
import { percentile95 } from '../backend/telemetry.js';

async function sourceManifest() {
  const files=['package.json','package-lock.json','.node-version','render.yaml'];
  async function walk(directory){for(const entry of await readdir(path.join(APP_ROOT,directory),{withFileTypes:true})){
    const file=`${directory}/${entry.name}`;if(entry.isDirectory())await walk(file);else if(entry.isFile()&&file.endsWith('.js'))files.push(file);
  }}
  await walk('backend');await walk('tests');await walk('scripts');
  return Object.fromEntries(await Promise.all(files.sort().map(async file=>[file,createHash('sha256').update(await readFile(path.join(APP_ROOT,file))).digest('hex')])));
}

export async function runResource({smoke=false,profile=false,out}={}) {
  const parent=path.join(APP_ROOT,'data/test-runs');await mkdir(parent,{recursive:true});
  if((await lstat(parent)).isSymbolicLink() || !isWithin(APP_ROOT,await realpath(parent))) throw Error('UNSAFE_RESOURCE_PATH');
  const directory=await mkdtemp(path.join(parent,'resource-'));
  const report={report_schema_version:'resource-report-v1',workload:profile?'resource-profile-v1':smoke?'resource-smoke-v1':'resource-small-v1',
    latency_basis:'CLIENT_HTTP',started_at:new Date().toISOString(),complete:false,targets:'UNAVAILABLE',memory_sampling_interval_ms:profile?100:1000,
    limits:{warmups:smoke||profile?0:10,measurements:profile?20:smoke?2:120,minimum_spacing_ms:1200,rss_interval_ms:100,rss_limit_bytes:85000000,p95_target_ms_exclusive:35},
    rss:{pid:null,baseline_bytes:null,peak_bytes:null,sample_count:0,max_server_gap_ms:0,max_receipt_gap_ms:0},background:{completed:0,failed:0},groups:[]};
  let child,stop=false,pollers=[],lastServer,lastReceived,ready,readyReject;
  const readyPromise=new Promise((resolve,reject)=>{ready=resolve;readyReject=reject;});
  try {
    const fixture=await resourceFixture(directory);Object.assign(report,{fixture:fixture.fixture,fixture_source_sha256:fixture.fixture_source_sha256,counts:fixture.counts,clinical_heads:fixture.heads});
    report.source_sha256=await sourceManifest();report.environment_note='Owned server RSS; local Windows host, not a dedicated performance machine.';
    child=fork(path.join(APP_ROOT,'tests/resource-server.js'),[],{cwd:APP_ROOT,windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],
      env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH}});
    child.on('message',message=>{
      if(message.pid && message.pid!==child.pid) {readyReject(Error('WRONG_RESOURCE_PID'));return;}
      if(message.type==='ready') {Object.assign(report,{server_pid:message.pid,node:message.node,sqlite:message.sqlite,pragmas:message.pragmas,runtime:message.runtime});ready(message);}
      if(message.type==='failed') readyReject(Error('RESOURCE_STARTUP_FAILED'));
      if(message.type==='allocation_profile')report.allocation_hotspots=message.hotspots;
      if(message.type==='rss') {
        if(!Number.isFinite(message.rss)||message.rss<=0||!Number.isFinite(message.at)) {report.rss.invalid=true;return;}
        const received=performance.now();report.rss.pid=message.pid;
        if(message.memory){report.memory_baseline??=message.memory;
          report.memory_peak=Object.fromEntries(Object.entries(message.memory).map(([key,value])=>[key,Math.max(value,report.memory_peak?.[key]??0)]));
          report.memory_final=message.memory;}
        report.rss.baseline_bytes ??= message.rss;report.rss.peak_bytes=Math.max(report.rss.peak_bytes??0,message.rss);report.rss.sample_count+=1;
        if(lastServer!==undefined) report.rss.max_server_gap_ms=Math.max(report.rss.max_server_gap_ms,message.at-lastServer);
        if(lastReceived!==undefined) report.rss.max_receipt_gap_ms=Math.max(report.rss.max_receipt_gap_ms,received-lastReceived);
        lastServer=message.at;lastReceived=received;
      }
    });child.once('error',readyReject);child.once('exit',()=>readyReject(Error('RESOURCE_CHILD_EXITED')));
    child.send({type:'start',db:fixture.db,profile});
    const startTimer=setTimeout(()=>readyReject(Error('RESOURCE_STARTUP_TIMEOUT')),10000);
    let running;try {running=await readyPromise;}finally{clearTimeout(startTimer);}
    const base=`http://127.0.0.1:${running.port}`,origin='http://127.0.0.1:3000';
    async function request(route,{method='GET',body,actor}={}) {
      const serialized=body===undefined?undefined:JSON.stringify(body),begin=process.hrtime.bigint();
      try {
        const response=await fetch(`${base}${route}`,{method,signal:AbortSignal.timeout(10000),headers:{...(method==='POST'?{Origin:origin,'Content-Type':'application/json','X-Idempotency-Key':randomUUID()}:{}),
          ...(actor?{Cookie:actor.cookie,...(method==='POST'?{'X-CSRF-Token':actor.csrf}:{})}:{})},...(serialized===undefined?{}:{body:serialized})});
        const buffer=Buffer.from(await response.arrayBuffer()),elapsed=Number(process.hrtime.bigint()-begin)/1e6;
        return {response,body:JSON.parse(buffer.toString('utf8')),elapsed,response_bytes:buffer.length,request_bytes:Buffer.byteLength(serialized??'')};
      }catch(error){error.elapsed=Number(process.hrtime.bigint()-begin)/1e6;throw error;}
    }
    async function login(username) {const r=await request('/api/v1/auth/login',{method:'POST',body:{username,password:fixture.passwords[username]}});
      if(r.response.status!==200) throw Error('RESOURCE_LOGIN_FAILED');return {cookie:r.response.headers.get('Set-Cookie').split(';')[0],csrf:r.body.csrf_token};}
    const clinician=await login('doctor12'),patient=await login('patient-a');
    const q=await request('/api/v1/encounters/encounter_demo_ledger/allowance/request',{method:'POST',actor:clinician,body:{explanation:'Fictional resource workload.'}});
    const approval=await request('/api/v1/encounters/encounter_demo_ledger/allowance/respond',{method:'POST',actor:patient,
      body:{consent_request_id:q.body.consent_request_id,expected_request_version:q.body.request_version,action:'ALLOW',approval_channel:'PHONE'}});
    if(approval.response.status!==200) throw Error('RESOURCE_APPROVAL_FAILED');report.grant_expires_at=approval.body.expires_at;
    for(const room of ['room_12','room_18']) pollers.push((async()=>{while(!stop){try{const r=await request(`/api/v1/queue/display/${room}`);
      if(r.response.status===200) report.background.completed+=1;else report.background.failed+=1;}catch{report.background.failed+=1;}
      await delay(2000);}})());
    let lastStart=-Infinity;
    for(const operation of ['VAULT_ACTIVE_STATE','VAULT_QUERY']) {
      const group={operation,attempted:0,completed:0,failed:0,timeouts:0,warmups:[],samples_ms:[],response_bytes:[],request_bytes:[],minimum_observed_spacing_ms:null,p95_ms:null,target_status:'UNAVAILABLE'};report.groups.push(group);
      for(let index=0;index<report.limits.warmups+report.limits.measurements;index+=1) {
        while(performance.now()-lastStart<1200)await delay(Math.max(1,Math.ceil(lastStart+1200-performance.now())));
        const started=performance.now();if(Number.isFinite(lastStart))group.minimum_observed_spacing_ms=Math.min(group.minimum_observed_spacing_ms??Infinity,started-lastStart);lastStart=started;
        if(Date.now()>=Date.parse(report.grant_expires_at)) throw Error('RESOURCE_GRANT_ENDED');
        const measured=index>=report.limits.warmups;if(measured) group.attempted+=1;
        try {
          const r=operation==='VAULT_QUERY'?await request('/api/v1/vault/query',{method:'POST',actor:clinician,body:{patient_id:'patient_demo_ledger',encounter_id:'encounter_demo_ledger',question_text:'Penicillin allergy history?'}}):
            await request('/api/v1/vault/patient/patient_demo_ledger/active-state?encounter_id=encounter_demo_ledger',{actor:clinician});
          if(r.response.status!==200 || r.body.as_of_sequence!==20 || (operation==='VAULT_QUERY'?r.body.certainty_state!=='VERIFIED_POSITIVE':r.body.event_count!==20)) throw Error('RESOURCE_UNEXPECTED_RESPONSE');
          if(measured){group.completed+=1;group.samples_ms.push(r.elapsed);group.response_bytes.push(r.response_bytes);group.request_bytes.push(r.request_bytes);}else group.warmups.push(r.elapsed);
        }catch(error){if(measured){if(error.name==='TimeoutError')group.timeouts+=1;else group.failed+=1;}group.failure_code='REQUEST_FAILED';throw error;}
      }
      if(!smoke && !profile && group.samples_ms.length>=100){group.p95_ms=percentile95(group.samples_ms);group.target_status=group.p95_ms<35?'TARGET_MET':'TARGET_MISSED';}
    }
    const telemetry=await request('/api/v1/system/telemetry',{actor:clinician});if(telemetry.response.status===200) report.runtime_telemetry=telemetry.body;
    report.complete=!smoke&&!profile;report.targets=smoke||profile?'UNAVAILABLE':'RECORDED_PER_GROUP';
  }catch(error){report.failure_code=/^RESOURCE_[A-Z_]+$/u.test(error.message)?error.message:'RESOURCE_RUN_FAILED';}
  finally {
    stop=true;await Promise.allSettled(pollers);
    if(child && child.exitCode===null && child.signalCode===null){await new Promise((resolve,reject)=>{
      const killTimer=setTimeout(()=>{child.kill();},5000);
      const exitTimer=setTimeout(()=>reject(Error('RESOURCE_CHILD_DID_NOT_STOP')),10000);
      child.once('exit',()=>{clearTimeout(killTimer);clearTimeout(exitTimer);resolve();});
      if(child.connected)child.send({type:'stop'});else child.kill();});}
    report.finished_at=new Date().toISOString();report.duration_seconds=(Date.parse(report.finished_at)-Date.parse(report.started_at))/1000;
    report.rss.last_sample_age_ms=lastReceived===undefined?null:performance.now()-lastReceived;
    const valid=report.complete && !report.rss.invalid && report.rss.sample_count>0 && report.rss.pid===report.server_pid &&
      report.rss.last_sample_age_ms!==null && report.rss.last_sample_age_ms<=1000 && report.rss.max_server_gap_ms<=1000 && report.rss.max_receipt_gap_ms<=1000;
    report.rss.target_status=valid?(report.rss.peak_bytes<=85000000?'TARGET_MET':'TARGET_MISSED'):'UNAVAILABLE';
    if(!isWithin(parent,directory)||directory===parent||(await lstat(directory)).isSymbolicLink()||!isWithin(parent,await realpath(directory))) throw Error('UNSAFE_RESOURCE_CLEANUP');
    await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:50});
  }
  const target=privatePath(out??`data/reports/resource-${randomUUID()}.json`,{createParents:true});
  await writeFile(target,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});return {report,path:target};
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2);
  if(!['--run','--smoke','--profile'].includes(args[0]) || args.length>1){console.error('RESOURCE_RUN_REQUIRES_EXPLICIT_MODE: use --run, --smoke or --profile.');process.exitCode=1;}
  else {const result=await runResource({smoke:args[0]==='--smoke',profile:args[0]==='--profile'});console.log(JSON.stringify({report:result.path,complete:result.report.complete,targets:result.report.targets,
    groups:result.report.groups.map(g=>({operation:g.operation,completed:g.completed,p95_ms:g.p95_ms,target_status:g.target_status})),rss:result.report.rss}));
    if(result.report.failure_code)process.exitCode=1;}
}
