import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { APP_ROOT, isWithin } from './config.js';
import { openDatabase, StorageError, requireStorage } from './db.js';
import { loadRuntimeFixtures } from './manage.js';
import { parseJSON, verifyChains,supportedQuestions } from './services/vault.js';
import { createAuth, cookieReference, clearSessionCookie } from './auth.js';
import { createOperations } from './operations.js';
import { ApiError, loginSchema, emptySchema } from './schemas.js';
import * as schemas from './schemas.js';
import { createConsent } from './services/consent.js';
import { createQueue } from './services/queue.js';
import { createCapture } from './services/capture.js';
import { createVault } from './services/vault.js';
import { runChecks } from './services/checks.js';
import { createOutput } from './services/output.js';
import { createTelemetry } from './telemetry.js';
import { createSarvam,createClinicalAI } from './services/sarvam.js';

const pages=['login','patients','encounter','patient-visit'];
const operationKeySchema=z.uuid();
const healthPaths=new Set(['/api/v1/health/live','/api/v1/health/ready']);
const authPaths=new Set(['/api/v1/auth/login','/api/v1/auth/session','/api/v1/auth/logout']);
const allowedHeaders=['content-type','x-csrf-token','x-idempotency-key'];
const routeId='[A-Za-z0-9_-]{1,128}';
const domainPaths=new RegExp(`^/api/v1/(?:queue/register|queue/(?:rooms|display)/${routeId}|queue/rooms/${routeId}/(?:call-next|pause|resume)|queue/tokens/${routeId}/(?:repeat-call|absent|recall|transfer|withdraw)|encounters/${routeId}/(?:check-in|complete|break-glass|allowance/(?:request|respond|clarify|status|revoke))|patients/me/visit|navigation/route)$`,'u');
const clinicalPaths=new RegExp(`^/api/v1/(?:scribe/(?:transcribe|commit|drafts/${routeId}/(?:save|review))|encounters/${routeId}/(?:draft|summary|fhir-export)|vault/(?:query|affirmation|patient/${routeId}/(?:events|active-state))|audit/(?:integrity-check|patient|export)/${routeId})$`,'u');

export function createClock(clock={utc:Date.now,mono:()=>performance.now()}) {
  let utc=-1,mono=-1,trusted=true;
  return () => {
    const nextUtc=clock.utc(),nextMono=clock.mono();
    if(!Number.isSafeInteger(nextUtc) || nextUtc<utc || !Number.isFinite(nextMono) || nextMono<mono) trusted=false;
    if(!trusted) throw new ApiError('TIME_UNTRUSTED');
    utc=nextUtc;mono=nextMono;return utc;
  };
}

async function verifyPublicTree(root) {
  const stat=await lstat(root);
  requireStorage(stat.isDirectory() && !stat.isSymbolicLink() && isWithin(APP_ROOT,await realpath(root)),'INVALID_PUBLIC_FILES');
  for(const entry of await readdir(root,{withFileTypes:true})) {
    requireStorage(!entry.isSymbolicLink(),'INVALID_PUBLIC_FILES');
    const file=path.join(root,entry.name);
    if(entry.isDirectory()) await verifyPublicTree(file);
    else requireStorage(entry.isFile() && !entry.name.startsWith('.'),'INVALID_PUBLIC_FILES');
  }
}

function safeError(error) {
  if(error instanceof ApiError) return error;
  if(error.code==='CLINICAL_INTEGRITY_INVALID') return new ApiError('CLINICAL_INTEGRITY_INVALID');
  const commitState=error.commit_state==='UNKNOWN'?'UNKNOWN':'NOT_APPLIED';
  if(commitState==='UNKNOWN') return new ApiError('COMMIT_OUTCOME_UNKNOWN',{commitState});
  if(error.type==='entity.too.large') return new ApiError('PAYLOAD_TOO_LARGE');
  if(error.type==='encoding.unsupported') return new ApiError('UNSUPPORTED_MEDIA_TYPE');
  if(error.type==='request.aborted' || error.type==='request.size.invalid') return new ApiError('MALFORMED_JSON');
  if(error instanceof StorageError) {
    if(['EDGE_BUSY','AUDIT_UNAVAILABLE','IDEMPOTENCY_CONFLICT','TIME_UNTRUSTED'].includes(error.code)) return new ApiError(error.code,{commitState});
    return new ApiError('DEPENDENCY_UNAVAILABLE',{commitState});
  }
  if(/^SQLITE_/u.test(error.code ?? '') || /database connection is not open/iu.test(error.message ?? '')) {
    return new ApiError('DEPENDENCY_UNAVAILABLE',{commitState});
  }
  return new ApiError('INTERNAL_ERROR',{commitState});
}

// Constructor hooks are private test seams. No route, environment flag or request can select one.
export async function createApp(settings,{clock,hooks={},fixtureDirectory,aiOptions={}}={}) {
  requireStorage(Number(process.versions.node.split('.')[0])===24,'NODE_24_REQUIRED');
  for(const root of ['frontend','assets']) await verifyPublicTree(path.join(APP_ROOT,root));
  for(const file of [...pages.flatMap(page=>[`frontend/${page}/index.html`,`frontend/${page}/${page}.js`,`frontend/${page}/${page}.css`]),
    ...['api','session','ui','config'].map(name=>`frontend/shared/${name}.js`),'assets/css/tailwind.css']) {
    const entry=await lstat(path.join(APP_ROOT,file));
    requireStorage(entry.isFile() && (file!=='assets/css/tailwind.css' || entry.size>0),'INVALID_PUBLIC_FILES');
  }
  const fixtures=loadRuntimeFixtures(fixtureDirectory);
  const now=createClock(clock);
  const store=openDatabase(settings.dbPath,{verifyClinical:verifyChains,now:now()});
  let auth;
  try {
    const nodes=new Set(fixtures.map.nodes.map(node=>node.node_id));
    requireStorage(store.verification.map_version===fixtures.map.map_version &&
      store.db.prepare('SELECT map_node FROM rooms').all().every(room=>nodes.has(room.map_node)),'INVALID_FIXTURE');
    auth=await createAuth(store,settings,{now,hooks});
  } catch(error) {store.close();throw error;}
  const operations=createOperations(store,auth,{now,hooks});
  const consent=createConsent(store,auth,operations,{now});
  const queue=createQueue(store,auth,operations,consent,{now,map:fixtures.map});
  const capture=createCapture(store,auth,operations,{now,settings,mock:fixtures.mock,hooks});
  const vault=createVault(store,auth,operations,{now});
  const output=createOutput(store,auth,operations,{now,hooks});
  const telemetry=createTelemetry({utc:now});
  const app=express();app.disable('x-powered-by');app.disable('etag');app.set('trust proxy',false);
  const sarvam=createSarvam(settings.sarvam,{now,shutdownSignal:()=>app.locals.shutdownSignal,...aiOptions});
  const ai=createClinicalAI(store,auth,operations,capture,vault,sarvam,{now});
  app.enable('case sensitive routing');app.enable('strict routing');
  Object.assign(app.locals,{store,auth,operations,consent,queue,capture,vault,output,telemetry,ai,fixtures,now,draining:false,
    close(){app.locals.draining=true;auth.close();store.close();}});
  app.use((req,res,next)=>{const started=performance.now();
    res.once('finish',()=>{if(res.locals.authorizedQuery && res.statusCode===200) telemetry.recordQuery(performance.now()-started);});
    res.locals.requestId=randomUUID();res.set('X-Request-ID',res.locals.requestId);next();});
  app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'"],
    connectSrc:["'self'",settings.apiOrigin],imgSrc:["'self'"],fontSrc:["'self'"],objectSrc:["'none'"],
    baseUri:["'none'"],frameAncestors:["'none'"],formAction:["'self'"],upgradeInsecureRequests:settings.loopbackHttp?null:[]}},
    strictTransportSecurity:settings.loopbackHttp?false:{maxAge:31536000},referrerPolicy:{policy:'no-referrer'}}));
  function json(res,body,status=200) {
    return res.status(status).json({...body,request_id:res.locals.requestId,server_time:new Date(Date.now()).toISOString()});
  }
  app.use('/api', (req,res,next)=>{
    res.set('Cache-Control','no-store');res.vary('Origin');
    if(!healthPaths.has(req.originalUrl.split('?')[0])) res.set('X-Dataset-ID',store.verification.dataset_id);
    const origin=req.get('Origin');
    if(origin===settings.frontendOrigin) {
      res.set('Access-Control-Allow-Origin',origin);res.set('Access-Control-Allow-Credentials','true');
      res.set('Access-Control-Expose-Headers','X-Request-ID, X-Dataset-ID, Retry-After, X-Export-ID, X-FHIR-Validation, Content-Disposition');
    }
    if(req.method==='OPTIONS') {
      const requested=(req.get('Access-Control-Request-Headers') ?? '').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
      const requestedPath=req.originalUrl.split('?')[0];
      if(origin!==settings.frontendOrigin || !(authPaths.has(requestedPath) || domainPaths.test(requestedPath) || clinicalPaths.test(requestedPath) || ['/api/v1/system/telemetry','/api/v1/ai/records/ask','/api/v1/ai/consultation/brief'].includes(requestedPath)) ||
        !['GET','POST'].includes(req.get('Access-Control-Request-Method')) || requested.some(h=>!allowedHeaders.includes(h))) return next(new ApiError('ORIGIN_REJECTED'));
      res.vary('Access-Control-Request-Headers');res.vary('Access-Control-Request-Method');
      res.set('Access-Control-Allow-Methods','GET, POST');res.set('Access-Control-Allow-Headers',allowedHeaders.join(', '));return res.status(204).end();
    }
    if(!healthPaths.has(req.originalUrl.split('?')[0])) {
      try {if(app.locals.draining) throw new ApiError('SERVICE_NOT_READY');now();} catch(error) {return next(error);}
    }
    next();
  });
  app.get('/api/v1/health/live',(req,res)=>json(res,{status:'LIVE'}));
  app.get('/api/v1/health/ready',(req,res,next)=>{
    try {
      if(app.locals.draining) throw new Error();now();store.db.prepare('SELECT 1').get();
      return json(res,{status:'READY'});
    } catch {return next(new ApiError('SERVICE_NOT_READY',{commitState:'NOT_APPLICABLE'}));}
  });
  function postHeaders(req,res,next) {
    if(req.get('Origin')!==settings.frontendOrigin) return next(new ApiError('ORIGIN_REJECTED'));
    if(!operationKeySchema.safeParse(req.get('X-Idempotency-Key')).success) return next(new ApiError('VALIDATION_ERROR',{fields:[{path:'X-Idempotency-Key',code:'INVALID'}]}));
    if(Object.keys(req.query).length) return next(new ApiError('VALIDATION_ERROR'));
    if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(req.get('Content-Type') ?? '') ||
      (req.get('Content-Encoding') && req.get('Content-Encoding').toLowerCase()!=='identity')) return next(new ApiError('UNSUPPORTED_MEDIA_TYPE'));
    next();
  }
  const body=express.raw({type:()=>true,limit:65536,inflate:false});
  const validate=(schema,onInvalid)=>async(req,res,next)=>{
    try {
      let value;
      try {value=parseJSON(new TextDecoder('utf-8',{fatal:true}).decode(req.body ?? Buffer.alloc(0)),65536);} catch {throw new ApiError('MALFORMED_JSON');}
      const parsed=schema.safeParse(value);
      if(!parsed.success) throw new ApiError('VALIDATION_ERROR',{fields:parsed.error.issues.slice(0,8).map(issue=>({
        path:['username','password'].includes(issue.path[0])?issue.path[0]:'body',code:'INVALID'}))});
      req.validated=parsed.data;next();
    } catch(error) {
      try {if(onInvalid) await onInvalid(req,error);} catch(auditError) {return next(auditError);}
      next(error);
    }
  };
  const parameters=(...names)=>(req,res,next)=>{
    if(names.some(name=>!schemas.id.safeParse(req.params[name]).success)) return next(new ApiError('VALIDATION_ERROR'));
    next();
  };
  const query=schema=>(req,res,next)=>{
    const parsed=schema.safeParse(req.query);
    if(!parsed.success) return next(new ApiError('VALIDATION_ERROR'));
    req.validatedQuery=parsed.data;next();
  };
  const intent=req=>({method:'POST',path:req.path,body:req.validated,key:req.get('X-Idempotency-Key'),csrf:req.get('X-CSRF-Token')});
  const ref=req=>cookieReference(req.get('Cookie'));
  app.post('/api/v1/auth/login',postHeaders,body,validate(loginSchema),async(req,res)=>{
    const result=await auth.login({...req.validated,key:req.get('X-Idempotency-Key'),ref:cookieReference(req.get('Cookie')),
      sourceIp:req.socket.remoteAddress});
    if(result.cookie) res.set('Set-Cookie',result.cookie);
    return json(res,result.body);
  });
  app.get('/api/v1/auth/session',(req,res)=>{
    const result=auth.status(cookieReference(req.get('Cookie')));
    if(!result.authenticated && req.get('Cookie')) res.set('Set-Cookie',clearSessionCookie(settings));
    return json(res,result);
  });
  app.post('/api/v1/auth/logout',postHeaders,body,validate(emptySchema),async(req,res)=>{
    const result=await operations.executeCommand(cookieReference(req.get('Cookie')),
      {method:'POST',path:'/api/v1/auth/logout',body:req.validated,key:req.get('X-Idempotency-Key'),csrf:req.get('X-CSRF-Token')},
      ()=>({}),ctx=>{auth.endSession(ctx.session.session_id,ctx.actor.account_id,'LOGOUT',ctx.now);return {status:'SESSION_ENDED',changed:true};},
      {audit:ctx=>({patient_id:ctx.actor.patient_id ?? null,encounter_id:null,operation:'AUTH_LOGOUT',result:'SUCCESS',details:{session_id:ctx.session.session_id}})});
    res.set('Set-Cookie',clearSessionCookie(settings));return json(res,{authenticated:false,actor:null,...result});
  });
  app.post('/api/v1/queue/register',postHeaders,body,validate(schemas.registerSchema),async(req,res)=>json(res,await queue.command(ref(req),intent(req),'register')));
  for(const [action,schema] of [['call-next',schemas.queueVersionSchema],['pause',schemas.pauseSchema],['resume',schemas.queueVersionSchema]]) {
    app.post(`/api/v1/queue/rooms/:room_id/${action}`,parameters('room_id'),postHeaders,body,validate(schema),
      async(req,res)=>json(res,await queue.command(ref(req),intent(req),action,req.params.room_id)));
  }
  for(const [action,schema] of [['repeat-call',schemas.repeatCallSchema],['absent',schemas.absentSchema],['recall',schemas.recallSchema],['transfer',schemas.transferSchema],['withdraw',schemas.withdrawSchema]]) {
    app.post(`/api/v1/queue/tokens/:token_id/${action}`,parameters('token_id'),postHeaders,body,validate(schema),
      async(req,res)=>json(res,await queue.command(ref(req),intent(req),action,req.params.token_id)));
  }
  for(const [action,schema] of [['check-in',schemas.checkInSchema],['complete',schemas.queueVersionSchema]]) {
    app.post(`/api/v1/encounters/:encounter_id/${action}`,parameters('encounter_id'),postHeaders,body,validate(schema),
      async(req,res)=>json(res,await queue.command(ref(req),intent(req),action,req.params.encounter_id)));
  }
  for(const [action,schema] of [['request',schemas.requestAllowanceSchema],['respond',schemas.respondAllowanceSchema],['clarify',schemas.clarifyAllowanceSchema],['revoke',schemas.revokeAllowanceSchema]]) {
    app.post(`/api/v1/encounters/:encounter_id/allowance/${action}`,parameters('encounter_id'),postHeaders,body,validate(schema),
      async(req,res)=>json(res,await consent.command(ref(req),intent(req),req.params.encounter_id,action)));
  }
  app.post('/api/v1/encounters/:encounter_id/break-glass',parameters('encounter_id'),postHeaders,body,
    validate(schemas.breakGlassSchema,(req,error)=>consent.recordEmergencyDenial(ref(req),req.params.encounter_id,error.code)),async(req,res)=>{
      try {return json(res,await consent.command(ref(req),intent(req),req.params.encounter_id,'break-glass'));}
      catch(error) {
        if(error.commit_state==='NOT_APPLIED') await consent.recordEmergencyDenial(ref(req),req.params.encounter_id,error.code ?? 'INTERNAL_ERROR');
        throw error;
      }
    });
  app.get('/api/v1/queue/rooms/:room_id',parameters('room_id'),query(emptySchema),(req,res)=>json(res,queue.room(ref(req),req.params.room_id)));
  app.get('/api/v1/queue/display/:room_id',parameters('room_id'),query(emptySchema),(req,res)=>json(res,queue.display(req.params.room_id)));
  app.get('/api/v1/patients/me/visit',query(emptySchema),(req,res)=>json(res,queue.patientVisit(ref(req))));
  app.get('/api/v1/navigation/route',query(schemas.navigationSchema),(req,res)=>json(res,queue.route(req.validatedQuery)));
  app.get('/api/v1/encounters/:encounter_id/allowance/status',parameters('encounter_id'),query(emptySchema),(req,res)=>json(res,consent.status(ref(req),req.params.encounter_id)));
  function clinicalResponse(res,result) {
    if(result.locked || result.safe) return json(res,result.body);
    // Final auth/source check occurs immediately before queuing the complete JSON response.
    const value=JSON.parse(result.release().toString('utf8'));return json(res,value);
  }
  function captureAdmission(req,res,next) {
    try {
      const release=capture.admit(ref(req),req.get('X-CSRF-Token'));
      req.capturePermit={release,working:false};
      const finished=()=>{if(!req.capturePermit.working) release();};
      res.once('finish',finished);res.once('close',finished);req.once('aborted',finished);next();
    } catch(error) {next(error);}
  }
  app.post('/api/v1/scribe/transcribe',postHeaders,captureAdmission,body,validate(schemas.captureSchema),async(req,res)=>{
    req.capturePermit.working=true;
    try {await capture.beforeCapture();return clinicalResponse(res,await capture.command(ref(req),intent(req),'capture'));}
    finally {req.capturePermit.release();}
  });
  for(const [action,schema] of [['save',schemas.saveDraftSchema],['review',schemas.reviewDraftSchema]]) {
    app.post(`/api/v1/scribe/drafts/:draft_id/${action}`,parameters('draft_id'),postHeaders,body,validate(schema),
      async(req,res)=>clinicalResponse(res,await capture.command(ref(req),intent(req),action,req.params.draft_id)));
  }
  app.post('/api/v1/scribe/commit',postHeaders,body,validate(schemas.commitDraftSchema),
    async(req,res)=>clinicalResponse(res,await capture.command(ref(req),intent(req),'commit')));
  app.get('/api/v1/encounters/:encounter_id/draft',parameters('encounter_id'),query(emptySchema),
    async(req,res)=>clinicalResponse(res,await capture.readDraft(ref(req),req.params.encounter_id)));
  for(const [kind,schema] of [['events',schemas.historyQuerySchema],['active-state',schemas.clinicalQuerySchema]]) {
    app.get(`/api/v1/vault/patient/:patient_id/${kind}`,parameters('patient_id'),query(schema),
      async(req,res)=>clinicalResponse(res,await vault.read(ref(req),{patientId:req.params.patient_id,
        encounterId:req.validatedQuery.encounter_id,kind,query:req.validatedQuery})));
  }
  app.post('/api/v1/vault/query',postHeaders,body,validate(schemas.questionSchema),
    async(req,res)=>{const result=await vault.query(ref(req),intent(req));const value=JSON.parse(result.release().toString('utf8'));
      res.locals.authorizedQuery=true;return json(res,value);});
  app.post('/api/v1/vault/affirmation',postHeaders,body,validate(schemas.checkSchema),
    async(req,res)=>clinicalResponse(res,await runChecks(vault,ref(req),intent(req))));
  for(const format of ['summary','fhir-export']) {
    app.get(`/api/v1/encounters/:encounter_id/${format}`,parameters('encounter_id'),query(emptySchema),async(req,res)=>{
      const result=await output.generate(ref(req),req.params.encounter_id,format,{
        request_id:res.locals.requestId,server_time:new Date(now()).toISOString()});
      const buffer=result.release();
      res.set('X-Export-ID',result.generationId);res.set('X-FHIR-Validation','NOT_RUN');
      if(format==='fhir-export') res.set('Content-Disposition',`attachment; filename="vellum-${result.generationId}.json"`);
      return res.type(format==='summary'?'application/json':'application/fhir+json').send(buffer);
    });
  }
  app.get('/api/v1/audit/patient/:patient_id',parameters('patient_id'),query(schemas.auditQuerySchema),
    async(req,res)=>clinicalResponse(res,await operations.auditHistory(ref(req),req.params.patient_id,req.validatedQuery)));
  app.get('/api/v1/audit/integrity-check/:patient_id',parameters('patient_id'),query(emptySchema),
    async(req,res)=>clinicalResponse(res,await operations.integrity(ref(req),req.params.patient_id)));
  app.get('/api/v1/audit/export/:patient_id',parameters('patient_id'),query(emptySchema),async(req,res)=>{
    const result=await operations.exportOwnAudit(ref(req),req.params.patient_id);const buffer=result.release();
    res.set('X-Export-ID',result.generationId);res.set('Content-Disposition',`attachment; filename="vellum-audit-${result.generationId}.json"`);
    return res.type('application/json').send(buffer);
  });
  app.get('/api/v1/system/telemetry',query(emptySchema),(req,res)=>{
    store.runUnit(false,()=>{const ctx=auth.authenticate(ref(req));
      if(!['STAFF','CLINICIAN'].includes(ctx.actor.role)) throw new ApiError('SCOPE_DENIED');
      auth.room(ref(req),ctx.actor.room_ids[0],'queue:operate');});
    return json(res,telemetry.snapshot(capture.inFlight));
  });
  app.post('/api/v1/ai/records/ask',postHeaders,body,validate(schemas.aiAskSchema),
    async(req,res)=>clinicalResponse(res,await ai.ask(ref(req),intent(req))));
  app.post('/api/v1/ai/consultation/brief',postHeaders,body,validate(schemas.aiBriefSchema),
    async(req,res)=>clinicalResponse(res,await ai.brief(ref(req),intent(req))));
  app.use('/api',(req,res,next)=>next(new ApiError('RESOURCE_UNAVAILABLE')));
  app.get('/',(req,res)=>res.redirect(302,'/login/'));
  for(const name of [...pages,'shared']) app.use(`/${name}`,express.static(path.join(APP_ROOT,'frontend',name),{dotfiles:'deny',index:'index.html',fallthrough:false}));
  app.use('/assets',express.static(path.join(APP_ROOT,'assets'),{dotfiles:'deny',index:false,fallthrough:false}));
  app.use((req,res,next)=>next(new ApiError('RESOURCE_UNAVAILABLE')));
  app.use((error,req,res,next)=>{
    if(res.headersSent) return next(error);
    const staticFailure=!req.originalUrl.startsWith('/api/') && error.status>=400 && error.status<500;
    const safe=staticFailure && !(error instanceof ApiError)?new ApiError('RESOURCE_UNAVAILABLE'):safeError(error);
    if(['SESSION_ENDED','LOGIN_REAUTH_REQUIRED'].includes(safe.code)) res.set('Set-Cookie',clearSessionCookie(settings));
    if(safe.retryAfter) res.set('Retry-After',String(safe.retryAfter));
    return json(res,{error:safe.code,detail:safe.detail,retry_strategy:safe.retry_strategy,commit_state:safe.commit_state,
      ...(['AI_UNAVAILABLE','UNSUPPORTED_QUESTION'].includes(safe.code)?{supported_questions:supportedQuestions}:{}),
      ...(safe.fields?{fields:safe.fields}:{}),...(safe.issuance?{issuance:safe.issuance}:{})},safe.status);
  });
  return app;
}
