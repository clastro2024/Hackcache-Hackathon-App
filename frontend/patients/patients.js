import { api } from '../shared/api.js';
import { session } from '../shared/session.js';
import { mountHeader, createNotice, bindDialog, setFieldError, setText, announce, icon } from '../shared/ui.js';

const get=id=>document.getElementById(id);
const roomSelect=get('room'),content=get('queue-content'),rows=get('queue-rows');
const registration=get('registration'),registrationForm=get('registration-form');
const decision=get('queue-decision'),decisionForm=get('decision-form');
const registrationDialog=bindDialog(registration,{dismissible:false}),decisionDialog=bindDialog(decision);
const assistedDialog=bindDialog(get('assisted-sharing'));
let assistedPatient=null,assistedStatus=null,assistedReading=false,assistedSignature='';
let actor=null,roomId=null,snapshot=null,generation=0,timer,reading=false,working=false;
let pending=null,decisionAction=null,needsSession=true,ended=false,leaving=false,logoutIntent=null;
let lastRender='',destroyHeader=()=>{},registrationRoom=null,lastOutcome=null;
let logoutWorking=false;
const versions=new Map();

function node(tag,className,text) {
  const result=document.createElement(tag);if(className) result.className=className;
  if(text!==undefined) setText(result,text);return result;
}
function button(label,action,{secondary=false,danger=false}={}) {
  const result=node('button',`button${secondary?' button--secondary':''}${danger?' button--danger':''}`,label);
  result.type='button';result.dataset.queueControl='';result.addEventListener('click',action);
  result.disabled=working || Boolean(pending);return result;
}
function notice(target,title,message,tone='caution',action) {
  const region=get(target),key=JSON.stringify([title,message,tone,action?.label]);
  // Keep unchanged live-region content stable during background polling.
  if(region.dataset.noticeKey===key && region.childElementCount) return;
  region.dataset.noticeKey=key;region.replaceChildren(createNotice({title,message,tone,action}));
}
function header() {
  destroyHeader();destroyHeader=mountHeader(get('app-header'),{area:'provider',page:'patients',
    ...(actor?{accountLabel:actor.display_name,roleLabel:actor.role==='STAFF'?'Room staff':'Clinician',onSignOut:signOut}:{})});
}
function permitted(permission) {return actor?.permissions?.includes(permission);}
function canOperate() {return permitted('queue:operate');}
function staff() {return actor?.role==='STAFF';}
function canRegister() {return staff() && permitted('intake:register');}
function clinician() {return actor?.role==='CLINICIAN' && permitted('clinical:write');}
function schedule() {
  clearTimeout(timer);if(!ended && !leaving && !document.hidden) timer=setTimeout(poll,2000);
}
function lock() {
  const blocked=working || Boolean(pending) || !snapshot || ended || leaving;
  roomSelect.disabled=blocked;
  for(const control of document.querySelectorAll('[data-queue-control]')) control.disabled=blocked;
  for(const link of content.querySelectorAll('[data-encounter-link]')) {
    link.setAttribute('aria-disabled',String(blocked));link.tabIndex=blocked?-1:0;
    if(blocked) link.removeAttribute('href');else link.href=link.dataset.encounterLink;
  }
  get('pause-queue').disabled=blocked;get('register-patient').disabled=blocked || !canRegister();
  for(const el of get('assisted-form').querySelectorAll('button,input,textarea')) el.disabled=blocked;
  content.setAttribute('aria-busy',String(working));
}
function clearPrivate() {
  generation+=1;snapshot=null;lastRender='';content.hidden=true;rows.replaceChildren();
  get('absent-rows').replaceChildren();get('call-next-region').replaceChildren();
  get('last-contact').textContent='';get('service-state').textContent='';
  registrationDialog.close();decisionDialog.close();registrationForm.reset();decisionForm.reset();
  assistedDialog.close();assistedPatient=null;assistedStatus=null;get('assisted-form').reset();get('assisted-requests').replaceChildren();get('assisted-patient').textContent='';get('assisted-notice').replaceChildren();get('token-print').replaceChildren();
  get('decision-patient').textContent='';get('registration-room').textContent='';decisionAction=null;
  get('command-notice').replaceChildren();lock();
}
function endContext(message) {
  clearTimeout(timer);ended=true;pending=null;logoutIntent=null;actor=null;lastOutcome=null;versions.clear();clearPrivate();
  roomSelect.replaceChildren(node('option','','Sign-in required'));header();
  get('pause-queue').hidden=true;get('register-patient').hidden=true;
  notice('connection-notice','Sign in to continue',message,'caution',{label:'Go to sign in',onClick:()=>location.replace('../login/')});
}
api.onContextClear(reason=>{
  if(reason==='NETWORK_UNAVAILABLE') {
    clearPrivate();needsSession=true;
    if(!leaving && !ended) notice('connection-notice','Connection interrupted','The patient list has been cleared. Reconnecting to the server…');
  } else if(['SESSION_ENDED','SESSION_EXPIRED','DATASET_CHANGED'].includes(reason)) {
    if(leaving) {clearPrivate();return;}
    endContext(reason==='DATASET_CHANGED'?'The dataset changed. Sign in again before using this list.':'Your session ended. Patient details have been cleared.');
  } else if(reason==='SESSION_CHANGED' && actor) {
    // An account replacement invalidates even safe-looking queue responses.
    endContext('The account changed. Sign in again to continue.');
  }
});

function moreActions(patient,current) {
  const details=node('details','row-more'),summary=node('summary'),actions=node('div','stack row-menu');
  summary.append(node('span','','More actions'),icon('chevron'));
  summary.setAttribute('aria-label',`More actions for token ${patient.public_token}`);
  details.append(summary,actions);
  actions.append(button('Print token',()=>printToken(patient),{secondary:true}));
  if(staff() && permitted('consent:assist') && current && patient.checked_in) actions.append(button('Help with sharing choice',()=>openAssisted(patient),{secondary:true}));
  if((staff() && (!current || !patient.checked_in)) || (clinician() && current)) {
    actions.append(button('Withdraw visit',()=>openDecision('withdraw',patient),{danger:true}));
  }
  if(clinician() && current && patient.checked_in) {
    actions.append(button('Complete visit',()=>openDecision('complete',patient),{secondary:true}));
    actions.append(node('p','muted','Room transfer is unavailable: destination rooms and their current versions are not supplied by the API.'));
  }
  for(const action of actions.querySelectorAll('button')) action.className=`menu-action${action.classList.contains('button--danger')?' menu-action--danger':''}`;
  return actions.childElementCount?details:null;
}
function renderPatient(patient,current=false) {
  const row=node('tr',current?'ledger-current':'');row.setAttribute('role','row');
  const values=[current?'Current':patient.waiting_position,patient.public_token,patient.display_name];
  for(let index=0;index<3;index+=1) {
    const cell=node('td',index===1?'token':index===2?'patient-name':'numeric',values[index]);
    if(current && index===0) cell.replaceChildren(node('span','state-label','Current'));
    cell.setAttribute('role','cell');cell.dataset.label=['Position','Token','Patient'][index];row.append(cell);
  }
  const status=node('td','status-cell'),actions=node('td','actions-cell'),controls=node('div','row-actions');
  status.setAttribute('role','cell');actions.setAttribute('role','cell');status.dataset.label='Status';actions.dataset.label='Actions';
  if(current) {
    const state=node('span',`patient-status ${patient.checked_in?'consultation-state':'arrival-state'}`);
    state.append(icon(patient.checked_in?'check':'clock'),node('span','',patient.checked_in?'In consultation':'Awaiting arrival'));status.append(state);
    if(!patient.checked_in) {
      status.append(node('span','call-count',`Calls made: ${patient.call_attempts} of 3`));
      if(canOperate()) {
        controls.append(button('Confirm arrival',()=>openDecision('check-in',patient)));
        if(snapshot.service_state==='ACTIVE') {
          if(patient.call_attempts<3) {const repeat=button('Call again',()=>runCommand(`/queue/tokens/${patient.token_id}/repeat-call`,{encounter_id:patient.encounter_id,expected_version:snapshot.version},'Repeat call'),{secondary:true});repeat.prepend(icon('phone'));controls.append(repeat);}
          else controls.append(button('Mark absent',()=>openDecision('absent',patient),{secondary:true}));
        }
      }
    } else if(clinician()) {
      // The next page rechecks server authority; identifiers grant no access.
      const link=node('a','button','Open encounter');link.dataset.encounterLink=`../encounter/?${new URLSearchParams({encounter_id:patient.encounter_id,patient_id:patient.patient_id,room_id:roomId})}`;
      controls.append(link);
    } else status.append(node('span','call-count','The clinician continues care.'));
  } else if(patient.queue_state==='RECALLED') status.append(node('span','state-label returned-label','Returned'));
  else if(patient.queue_state==='TRANSFERRED') status.append(node('span','state-label transferred-label','Transferred'));
  else status.append(node('span','sr-only','Waiting'));
  actions.append(controls);const more=canOperate()?moreActions(patient,current):null;
  if(more && current) {more.classList.add('current-menu');actions.append(more);}
  else if(more) controls.append(more);
  row.append(status,actions);return row;
}
function renderQueue(value) {
  if(assistedPatient && value.current?.encounter_id!==assistedPatient.encounter_id) {assistedDialog.close();assistedPatient=null;assistedStatus=null;get('assisted-requests').replaceChildren();}
  const label=value.label || value.room_id;
  setText(roomSelect.selectedOptions[0],label);
  const service=get('service-state');service.replaceChildren();
  service.className=`status ${value.service_state==='ACTIVE'?'service-active':'service-paused'}`;
  service.append(node('span','status-dot'),node('span','',value.service_state==='ACTIVE'?'Active':'On break'));
  if(value.service_state!=='ACTIVE' && value.delay_message) get('service-state').append(node('span','muted',value.delay_message));
  const contact=Date.parse(value.server_time);
  const contacted=new Date(contact);
  setText(get('last-contact'),Number.isFinite(contact)?`Updated at ${contacted.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'})}, ${contacted.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}`:'Server contacted');
  get('last-contact').title=value.state_changed_at?`Queue state changed: ${new Date(value.state_changed_at).toLocaleString()}`:'';
  get('pause-queue').hidden=!canOperate();setText(get('pause-queue'),value.service_state==='ACTIVE'?'Pause queue':'Resume queue');
  get('pause-queue').prepend(icon(value.service_state==='ACTIVE'?'pause':'play'));
  get('register-patient').hidden=false;
  get('register-patient').title=canRegister()?'Register a patient in this room':'Registration requires an assigned room-staff account';
  if(canRegister()) get('register-patient').removeAttribute('aria-describedby');else get('register-patient').setAttribute('aria-describedby','registration-permission');
  // Preserve keyboard focus and disclosure state on unchanged two-second polls.
  const signature=JSON.stringify([value.room_id,value.version,value.current,value.waiting,value.absent]);
  if(signature!==lastRender) {
    const focus=document.activeElement;
    const lostFocus=content.contains(focus),wasAbsentOpen=get('absent-section').open;
    rows.replaceChildren(...(value.current?[renderPatient(value.current,true)]:[]),...value.waiting.map(patient=>renderPatient(patient)));
    get('empty-queue').hidden=Boolean(value.current || value.waiting.length);
    setText(get('empty-queue'),'No patients are waiting in this room.');
    const next=get('call-next-region');next.replaceChildren();
    if(!value.current && canOperate()) {
      if(value.service_state==='ACTIVE' && value.waiting.length) next.append(button('Call next patient',()=>runCommand(`/queue/rooms/${roomId}/call-next`,{expected_version:snapshot.version},'Call next patient')));
      else if(value.service_state!=='ACTIVE') next.append(node('p','muted','The queue is paused. Resume when the room is ready; calling the next patient is a separate action.'));
    }
    setText(get('absent-count'),`Absent patients (${value.absent.length})`);
    const absentChevron=icon('chevron');absentChevron.classList.add('absent-chevron');get('absent-count').prepend(absentChevron);
    get('absent-rows').replaceChildren(...value.absent.map(patient=>{
      const row=node('div','absent-row');row.append(node('span','token',patient.public_token),node('span','patient-name',patient.display_name));
      const actions=node('div','row-actions');
      if(staff() && canOperate()) actions.append(button('Confirm return',()=>openDecision('recall',patient),{secondary:true}));
      const more=canOperate()?moreActions(patient,false):null;if(more) actions.append(more);row.append(actions);return row;
    }));
    get('absent-section').open=wasAbsentOpen;lastRender=signature;
    if(lostFocus && focus!==document.body) {get('patients-title').tabIndex=-1;get('patients-title').focus();announce('The patient list changed. Review the current list before choosing an action.');}
  }
  content.hidden=false;lock();
}
async function poll() {
  clearTimeout(timer);
  if(reading || working || ended || leaving || document.hidden) {schedule();return;}
  reading=true;
  try {
    if(needsSession) {
      const recovered=await session.recover();if(ended || leaving) return;
      if(!recovered?.authenticated) {endContext('Use your assigned account to view patients.');return;}
      if(recovered.actor.role==='PATIENT') {location.replace('../patient-visit/');return;}
      if(!['STAFF','CLINICIAN'].includes(recovered.actor.role)) {endContext('This account cannot use the patient list.');return;}
      actor=recovered.actor;needsSession=false;header();
      if(!roomId) {
        const rooms=actor.room_ids ?? [];roomSelect.replaceChildren(...rooms.map(id=>{const option=node('option','',id);option.value=id;return option;}));
        roomId=rooms[0];
      }
      if(!roomId || !actor.room_ids.includes(roomId)) {ended=true;notice('connection-notice','No room assigned','Ask your setup operator to check this account.');lock();return;}
    }
    const selected=roomId,epoch=generation;
    const value=await api.read(`/queue/rooms/${selected}`);
    if(epoch!==generation || selected!==roomId || ended || leaving) return;
    if(value.room_id!==selected || !Number.isSafeInteger(value.version) || !Array.isArray(value.waiting) || !Array.isArray(value.absent)) throw new Error('Invalid room snapshot');
    if(value.version<(versions.get(selected) ?? -1)) return;
    versions.set(selected,value.version);snapshot=value;get('connection-notice').replaceChildren();renderQueue(value);
    if(get('assisted-sharing').open && !assistedReading && !pending) void loadAssisted();
    if(pending && !working) showPending();
    else if(lastOutcome && !working) notice('command-notice',lastOutcome.title,lastOutcome.message,lastOutcome.tone);
  } catch(error) {
    if(!ended && !leaving) {
      clearPrivate();needsSession=true;
      notice('connection-notice','Patient list unavailable','No patient details are being shown. The page will check the server again.','caution',{label:'Try again',onClick:poll});
      if(pending) showPending();
    }
  } finally {reading=false;schedule();}
}
function showPending() {
  if(!pending || ended || leaving) return;
  notice('command-notice',`${pending.label}: outcome not confirmed`,
    'Keep this page open. Do not repeat this as a new action. Check the original command with the server. Other queue actions are paused until its outcome is known.',
    'caution',{label:'Check outcome',onClick:executePending});lock();
}
async function runCommand(path,body,label,kind='queue') {
  if(working || pending || !snapshot || ended || leaving) return;
  // Capture exact body/key once; later polls must not change this command.
  generation+=1;lastOutcome=null;pending={intent:api.createIntent(path,body),label,kind};await executePending();
}
async function executePending() {
  if(!pending || working || ended || leaving) return;
  const command=pending;working=true;lock();
  notice('command-notice',`${command.label}…`,'Waiting for the server.','info');
  try {
    const result=await api.command(command.intent);
    if(pending!==command || ended || leaving) return;
    pending=null;
    const title=result.changed===false?(command.kind==='consent'?'Sharing status unchanged':'No queue change'):`${command.label} confirmed`;
    const message=command.kind==='registration'?result.message || `Token ${result.public_token}. Ask staff for directions to the room.`:
      result.message || 'The page is checking the current patient list.';
    lastOutcome={title,message,tone:result.changed===false?'neutral':'success'};
    notice('command-notice',title,message,lastOutcome.tone);announce(title);
  } catch(error) {
    if(pending!==command || ended || leaving) return;
    if(error.commit_state==='UNKNOWN' || error.retry_strategy==='SAME_KEY') showPending();
    else {
      api.forget(command.intent);pending=null;
      const conflict=error.status===409;
      const message=error.code==='QUEUE_CAPACITY_REACHED'?'This room has reached its visit limit. No new token was issued.':
        error.code==='ACTIVE_VISIT_EXISTS'?'This patient already has an unresolved visit. Use their existing token.':
        conflict?'The queue changed. Review the refreshed list before choosing an action again.':
        error.status===403?'This account is not permitted to perform this action.':
        error.status===429?'The server is busy. Wait before choosing the action again.':
        'The server did not accept this action. Review the current list before trying again.';
      lastOutcome={title:`${command.label} not completed`,message,tone:'caution'};
      notice('command-notice',lastOutcome.title,message,'caution');
    }
  } finally {
    snapshot=null;working=false;lock();
    if(!ended && !leaving) {needsSession=true;void poll();}
  }
}

async function printToken(patient) {
  if(!snapshot || working || pending || ended || leaving) return;
  const epoch=generation,room=roomId,label=snapshot.label,region=get('token-print');
  notice('command-notice','Preparing token…','Loading sample guidance for the printed slip.','info');
  let route=null;
  try {route=await api.read('/navigation/route',{origin:'entrance',destination:room,accessibility:'STEP_FREE',language:document.documentElement.lang==='hi'?'hi':'en'});} catch { /* A plain token and staff guidance remain useful without a sample route. */ }
  if(epoch!==generation || ended || leaving || document.hidden || !snapshot) return;
  region.replaceChildren(node('p','','VaultMed · Fictional visit token'),node('h1','numeric',patient.public_token),node('p','patient-name',patient.display_name),node('h2','',label));
  if(route?.status==='ROUTE_AVAILABLE') {const list=node('ol');for(const step of route.steps) list.append(node('li','',step.instruction));region.append(node('h2','','Sample step-free directions from entrance'),list);}
  region.append(node('p','',route?.message || 'Ask hospital staff for directions and assistance.'),node('p','field-help','Fictional sample map, not surveyed. This token is a visit reference, not authentication or permission to read records.'),node('p','','For urgent care, speak to qualified staff now.'));
  window.print();get('command-notice').replaceChildren();
}
window.addEventListener('afterprint',()=>get('token-print').replaceChildren());
function openAssisted(patient) {
  if(!staff() || !permitted('consent:assist') || !snapshot || pending || working || !patient.checked_in) return;
  assistedPatient=patient;assistedStatus=null;assistedSignature='';get('assisted-form').reset();get('assisted-requests').replaceChildren();
  setText(get('assisted-patient'),`${patient.public_token} · ${patient.display_name}`);assistedDialog.open();void loadAssisted();
}
async function loadAssisted() {
  if(!assistedPatient || assistedReading || !get('assisted-sharing').open || pending || working) return;
  assistedReading=true;const patient=assistedPatient,epoch=generation,started=performance.now();
  try {
    const status=await api.read(`/encounters/${patient.encounter_id}/allowance/status`);
    if(epoch!==generation || assistedPatient!==patient || !get('assisted-sharing').open) return;
    if(status.patient_id!==patient.patient_id || status.encounter_id!==patient.encounter_id) throw new Error('Wrong assistance context');
    assistedStatus=status;
    const requests=status.pending_requests,grants=status.active_grants;
    const signature=JSON.stringify([requests.map(({remaining_seconds,maximum_grant_seconds,...rest})=>rest),grants.map(({expires_in_seconds,...rest})=>rest)]);
    if(signature===assistedSignature) return;assistedSignature=signature;get('assisted-notice').replaceChildren();
    const region=get('assisted-requests');region.replaceChildren();
    const labels={'triage:read':'Recorded history','vault:query':'Visit questions','affirmation:run':'Optional checks','summary:export':'Reviewed summary','vault:read':'Detailed recorded history'};
    for(const request of requests) {
      const card=node('section','assist-request stack');card.append(node('h3','',status.clinician.display_name),node('p','',status.facility.display_name),node('p','',request.explanation),node('p','',request.scopes.map(scope=>labels[scope] ?? scope).join(' · ')),node('p','field-help',`Up to ${Math.min(15,Math.floor(request.maximum_grant_seconds/60))} minutes for this visit. Request ends ${new Date(request.expires_at).toLocaleTimeString()}.`));
      const label=node('label','field-label','Question for the clinician (required for Ask why)'),note=node('textarea','field-control'),actions=node('div','decision-buttons');note.maxLength=500;note.rows=2;note.id=`assist-note-${region.childElementCount}`;label.htmlFor=note.id;card.append(label,note,actions);
      const deadline=started+Math.max(0,Date.parse(request.expires_at)-Date.parse(status.server_time));
      for(const [text,action] of [['Allow','ALLOW'],['Deny','DENY'],['Ask why','ASK_WHY']]) if(request.allowed_actions.includes(action)) actions.append(button(text,()=>assistedChoice('respond',request,action,note.value,deadline),{secondary:true}));
      region.append(card);
    }
    for(const grant of grants) {
      const card=node('section','assist-request stack');card.append(node('h3','',grant.mode==='BREAK_GLASS'?'Emergency access (simulated registration)':'Sharing is active'),node('p','',grant.scopes.map(scope=>labels[scope] ?? scope).join(' · ')),node('p','field-help',`Ends ${new Date(grant.expires_at).toLocaleTimeString()}.`));
      if(grant.allowed_actions.includes('REVOKE')) card.append(button('Stop sharing',()=>assistedChoice('revoke',grant,null,'',started+Math.max(0,Date.parse(grant.expires_at)-Date.parse(status.server_time))),{secondary:true}));region.append(card);
    }
    if(!requests.length && !grants.length) region.append(node('p','muted','No sharing request or active grant for this encounter. The clinician must request access first.'));
  } catch {if(epoch===generation && assistedPatient===patient) {assistedStatus=null;get('assisted-requests').replaceChildren();notice('assisted-notice','Sharing status unavailable','Refresh the patient list and try again.');}}
  finally {assistedReading=false;lock();}
}
function assistedChoice(kind,item,action,note,deadline) {
  if(!staff() || !permitted('consent:assist') || !assistedStatus || !snapshot || pending || working || performance.now()>=deadline) return;
  if(!['assist-present','assist-identity','assist-choice'].every(id=>get(id).checked)) {notice('assisted-notice','Confirm the assistance','Confirm that the patient is present, their details were checked and you are recording their actual choice.');return;}
  if(action==='ASK_WHY' && !note.trim()) {notice('assisted-notice','Enter the patient’s question','Ask the patient what they would like explained.');return;}
  const assistance={patient_present:true,identity_check_confirmed:true,patient_choice_confirmed:true},body={approval_channel:'ASSISTED_QR',assistance};
  if(kind==='respond') Object.assign(body,{consent_request_id:item.consent_request_id,expected_request_version:item.request_version,action,...(note.trim()?{note:note.trim()}:{})});
  else Object.assign(body,{grant_id:item.grant_id,expected_grant_version:item.grant_version});
  const encounter=assistedPatient.encounter_id;assistedDialog.close();void runCommand(`/encounters/${encounter}/allowance/${kind}`,body,'Patient sharing choice','consent');
}

function openDecision(kind,patient=null) {
  if(!snapshot || pending || working) return;
  const expected_version=snapshot.version;
  const config={
    'check-in':['Confirm arrival','Check the patient’s name and visit/token details with the person present. Confirming arrival does not share clinical history.','Confirm arrival'],
    absent:['Mark patient absent','Three calls have been recorded. Confirm that this patient is absent. This parks their token and calls the next patient if anyone is waiting.','Confirm absent'],
    recall:['Confirm patient return','Confirm that this patient has returned. Their existing token rejoins ahead of ordinary waiting entries; current care is not interrupted.','Confirm return'],
    withdraw:['Withdraw visit','This removes the visit from the queue and ends any sharing for its current encounter. The next patient will not be called automatically.','Withdraw visit'],
    complete:['Complete visit','Check that any intended clinical record has been committed in the encounter. Completion does not save a draft. It ends sharing and releases the room; the next call remains separate.','Complete visit'],
    pause:['Pause queue','Current care and waiting order are retained. Calls pause; existing sharing deadlines continue.','Pause queue'],
    resume:['Resume queue','The waiting order is retained. Call the next patient separately when the room is ready.','Resume queue'],
  }[kind];
  if(!config) return;
  decisionForm.reset();setText(get('decision-title'),config[0]);setText(get('decision-copy'),config[1]);
  setText(get('decision-patient'),patient?`${patient.public_token} · ${patient.display_name}`:snapshot.label);
  setText(get('confirm-decision'),config[2]);get('reason-field').hidden=kind!=='withdraw';
  setFieldError(get('decision-reason'),get('reason-error'),'');
  decisionAction=()=>{
    let path,body={expected_version};
    if(kind==='check-in') {path=`/encounters/${patient.encounter_id}/check-in`;body.identity_check_confirmed=true;}
    else if(kind==='complete') path=`/encounters/${patient.encounter_id}/complete`;
    else if(['pause','resume'].includes(kind)) path=`/queue/rooms/${roomId}/${kind}`;
    else {
      path=`/queue/tokens/${patient.token_id}/${kind}`;
      if(patient.encounter_id) body.encounter_id=patient.encounter_id;
      if(kind==='absent') body.absence_confirmed=true;
      if(kind==='recall') body.return_confirmed=true;
      if(kind==='withdraw') body.reason=get('decision-reason').value.trim();
    }
    // Recall's strict body has no encounter ID even if a future snapshot supplies one.
    if(kind==='recall') delete body.encounter_id;
    decisionDialog.close();void runCommand(path,body,config[0]);
  };
  decisionDialog.open();
}
decisionForm.addEventListener('submit',event=>{
  event.preventDefault();if(!decisionAction || !snapshot || pending || working) return;
  if(!get('reason-field').hidden && !get('decision-reason').value.trim()) {
    setFieldError(get('decision-reason'),get('reason-error'),'Enter a reason.');get('decision-reason').focus();return;
  }
  decisionAction();
});
get('pause-queue').addEventListener('click',()=>openDecision(snapshot?.service_state==='ACTIVE'?'pause':'resume'));
roomSelect.addEventListener('change',()=>{if(working || pending) return;roomId=roomSelect.value;lastOutcome=null;clearPrivate();void poll();});

function registrationDirty() {return Boolean(registrationForm.elements.display_name.value || registrationForm.elements.date_of_birth.value || registrationForm.elements.language.value!=='en' || get('existing-patient').value);}
function registrationMode() {const existing=get('registration-mode').value==='existing';get('new-patient-fields').hidden=existing;get('existing-patient-field').hidden=!existing;registrationForm.elements.display_name.required=!existing;get('patient-language').closest('.field').hidden=existing;}
get('registration-mode').addEventListener('change',registrationMode);
function requestRegistrationClose() {
  if(registrationDirty()) {get('discard-registration').hidden=false;get('keep-editing').focus();}
  else registrationDialog.close();
}
get('register-patient').addEventListener('click',()=>{
  if(!snapshot || pending || working || !canRegister()) return;
  registrationRoom=roomId;registrationForm.reset();registrationMode();get('discard-registration').hidden=true;setFieldError(get('existing-patient'),get('existing-patient-error'),'');
  for(const [field,errorId] of [['display_name','patient-name-error'],['date_of_birth','patient-dob-error']]) setFieldError(registrationForm.elements[field],get(errorId),'');
  setText(get('registration-room'),snapshot.label);registrationDialog.open();
});
get('close-registration').addEventListener('click',requestRegistrationClose);
registration.addEventListener('cancel',event=>{event.preventDefault();requestRegistrationClose();});
registration.addEventListener('click',event=>{
  if(event.target!==registration) return;const rect=registration.getBoundingClientRect();
  if(event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom) requestRegistrationClose();
});
get('keep-editing').addEventListener('click',()=>{get('discard-registration').hidden=true;registrationForm.elements.display_name.focus();});
get('discard-details').addEventListener('click',()=>{registrationForm.reset();registrationDialog.close();});
registrationForm.addEventListener('submit',event=>{
  event.preventDefault();if(!snapshot || registrationRoom!==roomId || pending || working || !canRegister()) return;
  if(get('registration-mode').value==='existing') {
    const field=get('existing-patient'),patient_id=field.value.trim();
    setFieldError(field,get('existing-patient-error'),/^[A-Za-z0-9_-]{1,128}$/u.test(patient_id)?'':'Enter the existing local patient reference.');
    if(field.getAttribute('aria-invalid')==='true') {field.focus();return;}
    registrationDialog.close();registrationForm.reset();void runCommand('/queue/register',{room_id:registrationRoom,intake_mode:'MANUAL',patient_id},'Registration','registration');return;
  }
  const name=registrationForm.elements.display_name,dob=registrationForm.elements.date_of_birth;
  const date=dob.value,localNow=new Date(),today=`${localNow.getFullYear()}-${String(localNow.getMonth()+1).padStart(2,'0')}-${String(localNow.getDate()).padStart(2,'0')}`;
  const nameError=name.value.trim()?'':'Enter the patient’s name.';
  const dateError=dob.validity.badInput || (date && (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || date>today))?'Enter a valid date of birth that is not in the future.':'';
  setFieldError(name,get('patient-name-error'),nameError);setFieldError(dob,get('patient-dob-error'),dateError);
  if(nameError || dateError) {(nameError?name:dob).focus();return;}
  const patient={display_name:name.value.trim(),language:registrationForm.elements.language.value,...(date?{date_of_birth:date}:{})};
  registrationDialog.close();registrationForm.reset();
  void runCommand('/queue/register',{room_id:registrationRoom,intake_mode:'MANUAL',patient},'Registration','registration');
});

async function signOut() {
  if(logoutWorking) return;
  if(!leaving) {leaving=true;clearTimeout(timer);lastOutcome=null;clearPrivate();}
  if(!logoutIntent) logoutIntent=api.createIntent('/auth/logout',{});
  logoutWorking=true;
  notice('connection-notice','Signing out…','Patient details have been cleared.','info');
  try {
    await api.command(logoutIntent);api.clear('SESSION_ENDED');location.replace('../login/');
  } catch(error) {
    if(error.status===401 || ['SESSION_ENDED','SESSION_EXPIRED','INTENT_INVALIDATED'].includes(error.code)) {location.replace('../login/');return;}
    const uncertain=error.commit_state==='UNKNOWN' || error.retry_strategy==='SAME_KEY';
    if(!uncertain) logoutIntent=null;
    notice('connection-notice','Sign-out not confirmed',uncertain?'Patient details remain hidden. Check the same sign-out with the server.':'Patient details remain hidden. The server did not accept sign-out; try again.','caution',{label:uncertain?'Check sign-out':'Try sign-out again',onClick:signOut});
  } finally {logoutWorking=false;}
}
document.addEventListener('visibilitychange',()=>{
  if(document.hidden) {clearTimeout(timer);clearPrivate();needsSession=true;}
  else if(!ended && !leaving) void poll();
});
window.addEventListener('pagehide',()=>{clearTimeout(timer);clearPrivate();api.clear('PAGE_LEFT');});
window.addEventListener('pageshow',event=>{if(event.persisted) location.reload();});
for(const close of document.querySelectorAll('#close-registration, #queue-decision .dialog-close, #assisted-sharing .dialog-close')) close.replaceChildren(icon('close'));
get('register-patient').prepend(icon('plus'));
content.addEventListener('keydown',event=>{
  const disclosure=event.target.closest('.row-more[open]');
  if(event.key==='Escape' && disclosure) {event.preventDefault();disclosure.open=false;disclosure.querySelector('summary').focus();}
});
document.addEventListener('pointerdown',event=>{for(const disclosure of content.querySelectorAll('.row-more[open]')) if(!disclosure.contains(event.target)) disclosure.open=false;});
header();void poll();
