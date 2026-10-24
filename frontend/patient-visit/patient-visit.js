import { api } from '../shared/api.js';
import { session } from '../shared/session.js';
import { mountHeader, createNotice, setText, setFieldError, announce, icon } from '../shared/ui.js';

const get=id=>document.getElementById(id);
let actor=null,visit=null,allowance=null,generation=0,reading=false,working=false,timer,expiryTimer;
let needsSession=true,ended=false,leaving=false,pending=null,logoutIntent=null,logoutWorking=false;
let summary=null,auditPage=null,outputWorking=false,lastSharing='',visitBinding=null,destroyHeader=()=>{};
const deadlines=new Map();
const scopeLabels={'triage:read':'Recorded history','vault:query':'Visit questions','affirmation:run':'Optional checks','summary:export':'A copy of your reviewed summary','vault:read':'Detailed recorded history'};
const node=(tag,className,text)=>{const el=document.createElement(tag);if(className) el.className=className;if(text!==undefined) setText(el,text);return el;};
function button(label,handler,className='button button--secondary') {const el=node('button',className,label);el.type='button';el.addEventListener('click',handler);return el;}
function notice(id,title,message,tone='caution',action) {
  const region=get(id),key=JSON.stringify([title,message,tone,action?.label]);
  if(region.dataset.noticeKey===key && region.childElementCount) return;
  region.dataset.noticeKey=key;region.replaceChildren(createNotice({title,message,tone,action}));
}
function date(value,options={dateStyle:'medium',timeStyle:'short'}) {const parsed=new Date(value);return Number.isFinite(parsed.getTime())?parsed.toLocaleString(undefined,options):'Time unavailable';}
function header() {destroyHeader();destroyHeader=mountHeader(get('app-header'),{area:'patient',accountLabel:'Account',...(actor?{onSignOut:signOut}:{})});}
function latestEncounter() {return visit?.latest_encounter_id ?? null;}
function lock() {
  const unavailable=!actor || ended || leaving || get('patient-content').hidden;
  for(const el of get('sharing').querySelectorAll('button,textarea')) el.disabled=unavailable || working || Boolean(pending);
  get('view-summary').disabled=unavailable || outputWorking || !latestEncounter();
  get('print-summary').disabled=unavailable || outputWorking || !summary;
  get('download-fhir').disabled=unavailable || outputWorking || !latestEncounter();
  for(const id of ['load-audit','more-audit','check-integrity','download-audit']) get(id).disabled=unavailable || outputWorking;
}
function clearSummary() {
  summary=null;get('summary-content').replaceChildren();get('summary-content').hidden=true;
  get('print-content').replaceChildren();get('print-summary').hidden=true;get('visit-summary').classList.remove('has-summary');
  setText(get('view-summary'),'View reviewed summary');get('summary-notice').replaceChildren(node('p','muted','Your reviewed summary will appear here.'));
}
function clearPrivate() {
  generation+=1;visit=null;allowance=null;lastSharing='';clearTimeout(expiryTimer);
  get('patient-content').hidden=true;get('patient-name').textContent='';get('visit-reference').textContent='';get('sharing').replaceChildren();
  get('choice-notice').replaceChildren();clearSummary();auditPage=null;
  for(const id of ['audit-rows','integrity-result','record-notice']) get(id).replaceChildren();
  get('more-audit').hidden=true;get('record-details').open=false;lock();
}
function endContext(message) {
  ended=true;clearTimeout(timer);pending=null;logoutIntent=null;actor=null;visitBinding=null;deadlines.clear();clearPrivate();header();
  notice('visit-notice','Sign in to continue',message,'caution',{label:'Go to sign in',onClick:()=>location.replace('../login/')});
}
api.onContextClear(reason=>{
  if(reason==='NETWORK_UNAVAILABLE') {
    needsSession=true;clearPrivate();if(!ended && !leaving) notice('visit-notice','Connection interrupted','Your visit details have been cleared. Reconnecting…');
  } else if(['SESSION_ENDED','SESSION_EXPIRED','DATASET_CHANGED'].includes(reason)) {
    if(leaving) {clearPrivate();return;}
    endContext(reason==='DATASET_CHANGED'?'The dataset changed. Sign in again.':'Your session ended. Your visit details have been cleared.');
  } else if(reason==='SESSION_CHANGED' && actor) endContext('The account changed. Sign in again to see your own visit.');
});
function schedule() {clearTimeout(timer);if(!ended && !leaving && !document.hidden) timer=setTimeout(poll,2000);}
function rememberDeadlines(value,serverTime,started) {
  const server=Date.parse(serverTime);if(!Number.isFinite(server)) throw new Error('Invalid contact time');
  for(const item of [...value.pending_requests,...value.active_grants]) {
    const id=item.consent_request_id || item.grant_id;
    const delta=Math.max(0,Math.min(Date.parse(item.expires_at)-server,(item.remaining_seconds ?? item.expires_in_seconds)*1000));
    if(!id || !Number.isFinite(delta)) throw new Error('Invalid sharing deadline');
    deadlines.set(id,Math.min(deadlines.get(id) ?? Infinity,started+delta));
  }
}
function live(item) {return (deadlines.get(item.consent_request_id || item.grant_id) ?? 0)>performance.now();}
function scopes(values) {return values.map(value=>scopeLabels[value] ?? 'Unrecognized scope — ask staff before allowing').join(' · ');}
function durationCopy(request) {const seconds=Math.min(900,Math.max(0,request.maximum_grant_seconds));return seconds>=900?'Up to 15 minutes for this visit.':`Up to ${Math.floor(seconds/60)} min ${seconds%60} sec for this visit.`;}
function actionAllowed(item,action) {return live(item) && item.allowed_actions?.includes(action) && !working && !pending && !ended && !leaving;}
function requestCard(request,index) {
  const card=node('article','sharing-request'),heading=node('h2','',index?'Another request to share records':'Share records for this visit?');card.append(heading);
  card.append(node('p','request-clinician',allowance.clinician.display_name),node('p','muted',allowance.facility.display_name));
  const facts=node('dl','request-facts');
  for(const [label,value] of [['Why?',request.explanation],['What is shared?',scopes(request.scopes)],['How long?',durationCopy(request)]]) {
    const group=node('div'),description=node('dd','',value);if(label==='How long?') description.dataset.durationFor=request.consent_request_id;
    group.append(node('dt','',label),description);facts.append(group);
  }
  card.append(facts);
  if(request.request_state==='CLARIFICATION_REQUESTED') card.append(node('p','muted','You asked for an explanation. You can decide after reading the clinician’s reply.'));
  const choices=node('div','decision-buttons');
  for(const [label,action] of [['Allow','ALLOW'],['Deny','DENY']]) if(request.allowed_actions.includes(action)) choices.append(button(label,()=>decide(request,action)));
  card.append(choices);
  if(request.allowed_actions.includes('ASK_WHY')) {
    const ask=button('Ask why',()=>{form.hidden=!form.hidden;if(!form.hidden) input.focus();},'text-link ask-why');ask.setAttribute('aria-expanded','false');
    const form=node('form','stack ask-why-form');form.hidden=true;form.id=`why-${index}`;ask.setAttribute('aria-controls',form.id);
    ask.addEventListener('click',()=>ask.setAttribute('aria-expanded',String(!form.hidden)));
    const label=node('label','field-label','What would you like explained?'),input=node('textarea','field-control'),error=node('p','field-error');
    input.id=`why-note-${index}`;input.maxLength=500;input.rows=3;label.htmlFor=input.id;error.id=`why-error-${index}`;error.hidden=true;
    const send=button('Send question',()=>{});send.type='submit';form.noValidate=true;form.append(label,input,error,send);
    form.addEventListener('submit',event=>{event.preventDefault();const note=input.value.trim();setFieldError(input,error,note?'':'Enter what you would like explained.');if(!note) {input.focus();return;}void decide(request,'ASK_WHY',note);});
    card.append(ask,form);
  }
  card.append(node('p','request-deadline',`Please choose by ${date(request.expires_at,{timeStyle:'short'})}. Allowing applies only to this visit. Your care can continue if you deny.`));
  return card;
}
function grantCard(grant) {
  const card=node('article','sharing-active'),mark=node('span','sharing-mark'),copy=node('div');mark.append(icon(grant.mode==='BREAK_GLASS'?'warning':'check'));
  copy.append(node('h2','',`${grant.mode==='BREAK_GLASS'?'Emergency access for':'Sharing with'} ${allowance.clinician.display_name}`));
  copy.append(node('p','muted',`${allowance.facility.display_name} · Ends at ${date(grant.expires_at,{timeStyle:'short'})}`),node('p','sharing-scopes',scopes(grant.scopes)));
  if(grant.mode==='BREAK_GLASS') copy.append(node('p','field-help','Emergency registration checking is simulated. This is separate from your sharing choice.'));
  card.append(mark,copy);
  if(grant.allowed_actions.includes('REVOKE')) card.append(button('Stop sharing',()=>revoke(grant)));
  return card;
}
function renderSharing() {
  clearTimeout(expiryTimer);
  const requests=(allowance?.pending_requests ?? []).filter(live),grants=(allowance?.active_grants ?? []).filter(live);
  // Polling must preserve focus, open question fields and a patient's unsent question.
  const signature=JSON.stringify([allowance?.clinician,allowance?.facility,requests.map(({remaining_seconds,maximum_grant_seconds,...rest})=>rest),grants.map(({expires_in_seconds,...rest})=>rest),Boolean(visit)]);
  if(signature!==lastSharing) {
    const focused=get('sharing').contains(document.activeElement);lastSharing=signature;
    const parts=[...grants.map(grantCard),...requests.map(requestCard)];
    if(!parts.length) {
      const section=node('div','sharing-empty'),state=(allowance?.active_grants?.length || allowance?.pending_requests?.length)?'EXPIRED':allowance?.grant?.grant_state || allowance?.request?.request_state;
      const label=state==='DENIED'?'You chose not to share':state==='REVOKED'?'Sharing stopped':['EXPIRED','ENDED','CANCELLED'].includes(state)?'Sharing has ended':'No sharing request right now';
      section.append(node('h2','',label),node('p','muted',visit?'A clinician’s request will appear here when it is available.':'No visit is linked to this account yet. Ask hospital staff for help.'));parts.push(section);
    }
    get('sharing').replaceChildren(...parts);
    if(focused) {get('sharing').tabIndex=-1;get('sharing').focus();}
  }
  for(const label of get('sharing').querySelectorAll('[data-duration-for]')) {const request=requests.find(item=>item.consent_request_id===label.dataset.durationFor);if(request) setText(label,durationCopy(request));}
  const times=[...requests,...grants].map(item=>deadlines.get(item.consent_request_id || item.grant_id));
  if(times.length) expiryTimer=setTimeout(()=>{lastSharing='';renderSharing();lock();void poll();},Math.max(1,Math.min(...times)-performance.now()+1));
  lock();
}
async function poll() {
  if(reading || working || ended || leaving || document.hidden) return;reading=true;
  try {
    if(needsSession) {
      const recovered=await session.recover();if(!recovered) {endContext('Sign in with your patient account.');return;}
      if(recovered.actor.role!=='PATIENT' || !recovered.actor.permissions.includes('patient:self') || !recovered.actor.permissions.includes('consent:decide')) {
        endContext('This page needs a patient account. Staff and clinicians use Patients.');return;
      }
      actor=recovered.actor;needsSession=false;header();
    }
    const epoch=generation,started=performance.now(),result=await api.read('/patients/me/visit');
    if(epoch!==generation || ended || leaving || document.hidden) return;
    const next=result.visit;
    if(next && next.patient_id!==actor.patient_id) throw new Error('Wrong patient context');
    const nextBinding=JSON.stringify([next?.visit_id,next?.latest_encounter_id]);
    if(visitBinding!==null && nextBinding!==visitBinding) {
      if(pending) api.forget(pending.intent);pending=null;deadlines.clear();clearPrivate();
    }
    visitBinding=nextBinding;
    visit=next;allowance=next?.allowance ?? null;
    if(allowance) {
      if(allowance.patient_id!==actor.patient_id || allowance.encounter_id!==next.encounter_id || !Array.isArray(allowance.pending_requests) || !Array.isArray(allowance.active_grants)) throw new Error('Invalid allowance context');
      rememberDeadlines(allowance,result.server_time,started);
    }
    get('patient-content').hidden=false;get('visit-notice').replaceChildren();setText(get('patient-name'),actor.display_name);
    setText(get('visit-reference'),`${next?.public_token?`Visit ${next.public_token} · `:''}Fictional demo`);
    renderSharing();if(pending) pendingNotice();lock();
  } catch(error) {
    if(ended || leaving) return;clearPrivate();needsSession=true;
    notice('visit-notice',error.status===429?'Please wait a moment':'Visit unavailable','Your details are hidden until the server can confirm your session and visit. Reconnecting…');
  } finally {reading=false;schedule();}
}
function pendingNotice() {notice('choice-notice','Choice not yet confirmed',`Check the same ${pending.label.toLowerCase()} with the server before making another choice.`,'caution',{label:'Check my choice',onClick:()=>runChoice(pending)});}
async function decide(request,action,note) {
  if(!actionAllowed(request,action)) return;
  await runChoice({intent:api.createIntent(`/encounters/${allowance.encounter_id}/allowance/respond`,{consent_request_id:request.consent_request_id,expected_request_version:request.request_version,action,approval_channel:'PHONE',...(note?{note}:{})}),label:action==='ASK_WHY'?'Question':action==='ALLOW'?'Allow choice':'Deny choice'});
}
async function revoke(grant) {
  if(!actionAllowed(grant,'REVOKE')) return;
  await runChoice({intent:api.createIntent(`/encounters/${allowance.encounter_id}/allowance/revoke`,{grant_id:grant.grant_id,expected_grant_version:grant.grant_version,approval_channel:'PHONE'}),label:'Stop sharing'});
}
async function runChoice(command) {
  if(working || ended || leaving || document.hidden) return;working=true;pending=command;lock();const epoch=++generation,started=performance.now();
  notice('choice-notice','Saving your choice…','Waiting for confirmation from the server.','info');
  try {
    const result=await api.command(command.intent);if(pending===command) pending=null;
    if(epoch===generation && !ended && !leaving && !document.hidden) {
      if(result.allowance?.encounter_id===visit?.encounter_id && result.allowance?.patient_id===actor.patient_id) {
        allowance=result.allowance;rememberDeadlines(allowance,result.server_time,started);renderSharing();
      }
      notice('choice-notice','Choice recorded','Your choice was saved. Checking the current sharing status…','success');announce('Your choice was recorded.');
    }
  } catch(error) {
    if(ended || leaving) return;
    if(error.commit_state==='UNKNOWN' || error.retry_strategy==='SAME_KEY') {pending=command;if(!get('patient-content').hidden) pendingNotice();}
    else {if(pending===command) pending=null;if(!get('patient-content').hidden) notice('choice-notice','Choice not saved',error.status===409 || error.status===410?'The request changed or ended. Read its current status before choosing again.':'The server did not accept this choice. Read the current status and try again.');}
  } finally {working=false;lock();void poll();}
}
function summaryView(value) {
  const fragment=document.createDocumentFragment();
  fragment.append(node('p','summary-review',`Reviewed by ${value.review.reviewer_display_name}`),node('p','summary-review',date(value.review.reviewed_at)));
  const narrative=node('section','summary-section');narrative.append(node('h3','','Visit note'),node('p','summary-copy',value.reviewed_text));fragment.append(narrative);
  for(const section of value.sections.filter(item=>['PRESCRIPTIONS','CONDITIONS','OTHER_STATEMENTS'].includes(item.key) && item.event_ids.length)) {
    const block=node('section','summary-section');block.append(node('h3','',section.title));
    for(const statement of value.statements.filter(item=>section.event_ids.includes(item.event.event_id))) block.append(node('p','summary-copy',statement.display_text.split('\n')[0]));
    fragment.append(block);
  }
  const details=node('details','summary-details'),copy=node('div','stack');details.append(node('summary','','Source and limits'),copy);
  copy.append(node('p','',value.capture.simulation_label || 'Manual clinician-reviewed capture'));
  for(const section of value.sections.filter(item=>item.key==='PROVENANCE')) copy.append(node('p','summary-copy',section.text));
  for(const warning of value.warnings) copy.append(node('p','',warning));fragment.append(details);return fragment;
}
const outputErrors={SUMMARY_NOT_COMMITTED:'Your clinician has not saved a final reviewed summary for this visit yet.',SUMMARY_OUTDATED:'This summary has changed after a correction. Ask your clinician for the current reviewed output.',SUMMARY_SOURCE_INVALID:'The summary’s source could not be verified. Ask hospital staff for help.',EXPORT_BUSY:'Another record is being prepared. Try again in a moment.',EXPORT_TOO_LARGE:'This record is too large to download as one file. Access history can still be read in pages.',AUDIT_UNAVAILABLE:'The access record could not be saved. No output was released.'};
async function readOutput(path,handle,{summaryOutput=false}={}) {
  if(outputWorking || !actor || ended || leaving || get('patient-content').hidden) return;
  outputWorking=true;lock();const epoch=generation,id=summaryOutput?'summary-notice':'record-notice';
  if(summaryOutput) clearSummary();notice(id,'Loading…','Checking your access and the saved record.','info');
  try {
    const value=await api.read(path);
    if(epoch!==generation || ended || leaving || document.hidden) return;
    if(value.patient_id && value.patient_id!==actor.patient_id) throw new Error('Wrong output context');
    handle(value);get(id).replaceChildren();
  } catch(error) {
    if(epoch===generation && !ended && !leaving && !document.hidden) notice(id,'Record unavailable',outputErrors[error.code] || 'The record could not be loaded. Try again or ask hospital staff for help.');
  } finally {outputWorking=false;lock();}
}
async function loadSummary({print=false}={}) {
  const encounter=latestEncounter();if(!encounter) return;
  await readOutput(`/encounters/${encounter}/summary`,value=>{
    if(value.patient_id!==actor.patient_id || value.encounter_id!==encounter || value.summary_schema_version!=='reviewed-summary-v1') throw new Error('Invalid summary');
    summary=value;get('summary-content').replaceChildren(summaryView(value),node('p','field-help',`Loaded ${date(value.generated_at)}. Refresh to check for changes.`));get('summary-content').hidden=false;
    get('visit-summary').classList.add('has-summary');get('print-summary').hidden=false;setText(get('view-summary'),'Refresh summary');
    if(print) {const region=get('print-content');region.replaceChildren(node('h1','','Your reviewed visit summary'),node('p','',value.patient_display_name),summaryView(value));for(const details of region.querySelectorAll('details')) details.open=true;window.print();}
  },{summaryOutput:true});
}
function saveJSON(value,prefix) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),link=node('a');
  link.href=url;link.download=`vaultmed-${prefix}-${crypto.randomUUID()}.json`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function loadAudit(more=false) {
  if(!actor) return;const patient=actor.patient_id;
  // Query fields pass through the bounded shared API helper, never a caller-selected patient.
  const params=more && auditPage?{after_audit_id:auditPage.next_after_audit_id,through_audit_id:auditPage.through_audit_id}:{};
  if(outputWorking || ended || leaving || get('patient-content').hidden) return;outputWorking=true;lock();const epoch=generation;
  notice('record-notice','Loading history…','Reading your recorded access and choices.','info');
  try {
    const value=await api.read(`/audit/patient/${patient}`,params);
    if(epoch!==generation || ended || leaving || document.hidden) return;
    if(value.patient_id!==patient || !Array.isArray(value.audit_events)) throw new Error('Invalid history');
    if(!more) get('audit-rows').replaceChildren();auditPage=value;
    for(const event of value.audit_events) {
      const row=node('li'),time=node('time','',date(event.recorded_at));time.dateTime=new Date(event.recorded_at).toISOString();
      row.append(node('p','',`${event.operation.replaceAll('_',' ')} · ${event.result}`),time,node('p','muted',`Account: ${event.actor_id ?? 'System'}`));get('audit-rows').append(row);
    }
    get('more-audit').hidden=value.next_after_audit_id===null;get('record-notice').replaceChildren();
    if(!value.audit_events.length) get('record-notice').append(node('p','muted','No recorded access in this snapshot.'));
  } catch {if(epoch===generation && !ended && !leaving) notice('record-notice','History unavailable','Try again or ask hospital staff for help.');}
  finally {outputWorking=false;lock();}
}
async function signOut() {
  if(logoutWorking) return;
  if(!leaving) {leaving=true;clearTimeout(timer);clearPrivate();}
  if(!logoutIntent) logoutIntent=api.createIntent('/auth/logout',{});logoutWorking=true;
  notice('visit-notice','Signing out…','Your visit details have been cleared. Signing out does not stop existing sharing.','info');
  try {await api.command(logoutIntent);api.clear('SESSION_ENDED');location.replace('../login/');}
  catch(error) {
    if(error.status===401 || ['SESSION_ENDED','SESSION_EXPIRED','INTENT_INVALIDATED'].includes(error.code)) {location.replace('../login/');return;}
    if(error.commit_state!=='UNKNOWN' && error.retry_strategy!=='SAME_KEY') logoutIntent=null;
    notice('visit-notice','Sign-out not confirmed','Your visit details remain hidden. Check sign-out with the server.','caution',{label:'Check sign-out',onClick:signOut});
  } finally {logoutWorking=false;}
}
get('view-summary').addEventListener('click',()=>loadSummary());get('print-summary').append(icon('print'));
get('print-summary').addEventListener('click',()=>loadSummary({print:true}));
get('load-audit').addEventListener('click',()=>loadAudit());get('more-audit').addEventListener('click',()=>loadAudit(true));
get('check-integrity').addEventListener('click',()=>{if(outputWorking) return;get('integrity-result').replaceChildren();void readOutput(`/audit/integrity-check/${actor.patient_id}`,value=>{
  const passed=value.status==='PASS';get('integrity-result').replaceChildren(createNotice({tone:passed?'info':'danger',title:passed?'Record links verified':'Record verification failed',message:passed?`Checked ${value.event_count} events at ${date(value.verified_at)}. This checks recorded links; it does not prove clinical truth.`:`Ask hospital staff for help. First affected sequence: ${value.first_failure_sequence ?? 'unavailable'}.`}));
});});
get('download-audit').addEventListener('click',()=>readOutput(`/audit/export/${actor.patient_id}`,value=>saveJSON(value,'access-history')));
get('download-fhir').addEventListener('click',()=>{const encounter=latestEncounter();if(encounter) void readOutput(`/encounters/${encounter}/fhir-export`,value=>saveJSON(value,'visit-record'));});
window.addEventListener('afterprint',()=>get('print-content').replaceChildren());
document.addEventListener('visibilitychange',()=>{if(document.hidden) {clearTimeout(timer);clearPrivate();needsSession=true;}else if(!ended && !leaving) void poll();});
window.addEventListener('pagehide',()=>{clearTimeout(timer);clearPrivate();api.clear('PAGE_LEFT');});
window.addEventListener('pageshow',event=>{if(event.persisted) location.reload();});
header();void poll();
