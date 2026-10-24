import path from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { loadServerSettings } from './config.js';
import { requireStorage } from './db.js';
import { createApp } from './app.js';

export async function startServer(settings=loadServerSettings(),options={}) {
  const {shutdownGraceMs=30000,...appOptions}=options;
  requireStorage(Number.isSafeInteger(shutdownGraceMs) && shutdownGraceMs>=1000 && shutdownGraceMs<=30000,'INVALID_SHUTDOWN_GRACE');
  const app=await createApp(settings,appOptions);
  const server=http.createServer({maxHeaderSize:16384,headersTimeout:15000,requestTimeout:30000,
    keepAliveTimeout:5000},app);
  server.maxRequestsPerSocket=1000;
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(settings.port,settings.host,()=>{server.off('error',reject);resolve();});});
  } catch(error) {app.locals.close();throw error;}
  let closing;
  const controller=new AbortController();
  app.locals.shutdownSignal=controller.signal;
  app.locals.forceDrainCount=0;
  function close() {
    if(closing) return closing;
    app.locals.draining=true;
    closing=new Promise(resolve=>{
      const timer=setTimeout(()=>{app.locals.forceDrainCount+=1;controller.abort();server.closeAllConnections();},shutdownGraceMs);timer.unref();
      server.close(()=>{clearTimeout(timer);app.locals.close();resolve();});
      server.closeIdleConnections();
    });
    return closing;
  }
  return {app,server,close};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const runtime=await startServer();
    console.log(`LISTENING ${runtime.server.address().address}:${runtime.server.address().port}`);
    const shutdown=()=>{runtime.close().catch(()=>{process.exitCode=1;});};
    process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  } catch(error) {
    const code=/^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code ?? '')?error.code:'STARTUP_FAILED';
    console.error(`STARTUP_FAILED: ${code}`);process.exitCode=1;
  }
}
