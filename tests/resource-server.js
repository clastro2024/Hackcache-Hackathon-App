// Private owned-child launcher only. No public diagnostics or production IPC handler.
import { startServer } from '../backend/server.js';
import { loadServerSettings } from '../backend/config.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { APP_ROOT } from '../backend/config.js';
import { getHeapStatistics } from 'node:v8';
let runtime,timer,profiler,sampleNumber=0;
function hotspots(profile) {
  const totals=new Map();
  function visit(node,owner='runtime/native') {
    const url=node.callFrame.url;
    if(url.startsWith('file:')) {const file=path.relative(APP_ROOT,fileURLToPath(url)).replaceAll('\\','/');
      if(file.startsWith('backend/'))owner=`${file}:${node.callFrame.lineNumber+1} ${node.callFrame.functionName}`;}
    totals.set(owner,(totals.get(owner)??0)+node.selfSize);
    for(const child of node.children??[])visit(child,owner);
  }
  visit(profile.head);return [...totals].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([location,bytes])=>({location,sampled_allocated_bytes:bytes}));
}
process.once('message',async message=>{
  try {
    const settings=loadServerSettings({FRONTEND_ORIGIN:'http://127.0.0.1:3000',API_ORIGIN:'http://127.0.0.1:3000',VAULTMED_DB_PATH:message.db});
    runtime=await startServer({...settings,port:0});
    if(message.profile){const {Session}=await import('node:inspector/promises');profiler=new Session();profiler.connect();await profiler.post('HeapProfiler.startSampling',{
      samplingInterval:32768,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});}
    const sample=()=>{if(process.connected) process.send({type:'rss',pid:process.pid,at:performance.now(),rss:process.memoryUsage.rss(),
      ...(profiler||sampleNumber++%10===0?{memory:process.memoryUsage()}: {})});};
    timer=setInterval(sample,100);sample();
    process.send({type:'ready',pid:process.pid,port:runtime.server.address().port,node:process.versions.node,
      runtime:{exec_argv:process.execArgv,heap_size_limit:getHeapStatistics().heap_size_limit},
      sqlite:runtime.app.locals.store.db.prepare('SELECT sqlite_version() version').get().version,
      pragmas:{journal_mode:runtime.app.locals.store.db.pragma('journal_mode',{simple:true}),synchronous:runtime.app.locals.store.db.pragma('synchronous',{simple:true}),
        foreign_keys:runtime.app.locals.store.db.pragma('foreign_keys',{simple:true}),busy_timeout:runtime.app.locals.store.db.pragma('busy_timeout',{simple:true})}});
  }catch {process.send?.({type:'failed'});process.exitCode=1;process.disconnect();}
});
process.on('message',async message=>{if(message.type==='stop' && runtime){clearInterval(timer);
  if(profiler){const {profile}=await profiler.post('HeapProfiler.stopSampling');process.send?.({type:'allocation_profile',hotspots:hotspots(profile)});profiler.disconnect();}
  await runtime.close();process.send?.({type:'stopped'});process.disconnect();}});
process.on('disconnect',()=>{clearInterval(timer);runtime?.close().catch(()=>{process.exitCode=1;});});
