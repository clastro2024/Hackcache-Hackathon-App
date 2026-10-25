import { api } from '../shared/api.js';
import { session } from '../shared/session.js';
import { mountHeader, bindTabs, bindDialog, createNotice, setText, setFieldError, announce, icon, localizedText, localizeUI, showLoader, hideLoader } from '../shared/ui.js';
import {hindiText} from '../shared/hindi.js';

showLoader();

const get=id=>document.getElementById(id),params=new URLSearchParams(location.search);
const context=Object.fromEntries(['encounter_id','patient_id','room_id'].map(key=>[key,params.get(key)]));
const validContext=Object.values(context).every(value=>/^[A-Za-z0-9_-]{1,128}$/u.test(value ?? ''));
const questions=['Any blood thinners or anticoagulants before surgery?','Penicillin allergy history?',
  'Any documented latex allergy assessment?','Historical renal impairment?','Any recorded surgeries?','Any recorded mental-health diagnoses?'];
const topics=['ANTITHROMBOTIC_MEDICATIONS','PENICILLIN_ALLERGY','LATEX_ALLERGY','RENAL_IMPAIRMENT','SURGICAL_HISTORY','MENTAL_HEALTH_HISTORY'];
const names={MEDICATION_RECORDED:'Medicine',CONDITION_RECORDED:'Condition',ALLERGY_RECORDED:'Allergy',
  PROCEDURE_RECORDED:'Procedure',NEGATIVE_FINDING_RECORDED:'Dated negative finding',RECORD_RETRACTED:'Retraction'};
const dialogs=Object.fromEntries(['review','item','action','source'].map(name=>[name,bindDialog(get(`${name}-dialog`))]));
let actor=null,ready=false,ended=false,closed=false,leaving=false,needsSession=true,needsDraft=true,reading=false;
let generation=0,historyEpoch=0,revision=0,roomVersion=-1,timer,expiryTimer,historyDeadline=0,grantKey='';
let allowance=null,history=null,draft=null,items=[],dirty=false,conflict=false,committed=false,editingItem=-1,actionSubmit=null;
let destroyHeader=()=>{},logoutIntent=null,logoutWorking=false;
const pending={write:null,history:null,access:null},working=new Set();
const historyKinds=new Set(['query','check','summary']);
const laneFor=kind=>['capture','save','review','commit','brief'].includes(kind)?'write':historyKinds.has(kind)?'history':'access';

function node(tag,className,text) {const el=document.createElement(tag);if(className) el.className=className;if(text!==undefined) setText(el,text);return el;}
function human(value) {return String(value ?? 'Not recorded').replaceAll('_',' ').toLowerCase().replace(/^./u,c=>c.toUpperCase());}
function notice(target,title,message,tone='caution',action) {
  const region=get(target),key=JSON.stringify([title,message,tone,action?.label]);
  if(region.dataset.noticeKey===key && region.childElementCount) return;
  region.dataset.noticeKey=key;region.replaceChildren(createNotice({title,message,tone,action}));
}
function textButton(label,callback) {const el=node('button','text-link',label);el.type='button';el.addEventListener('click',callback);return el;}
function detailsList(values) {
  const list=node('dl','definition-list');
  for(const [label,value] of values) {list.append(node('dt','',label),node('dd','',value===null || value===undefined || value===''?'Not recorded':String(value)));}
  return list;
}
function hasScope(scope) {
  return ready && !closed && historyDeadline>performance.now() && allowance?.active_grants?.some(grant=>
    grant.grant_state==='ACTIVE' && grant.scopes.includes(scope) && grantKey.startsWith(`${grant.grant_id}:`));
}
function header() {
  destroyHeader();destroyHeader=mountHeader(get('app-header'),{area:'provider',page:'encounter',
    ...(actor?{accountLabel:actor.display_name,roleLabel:'Clinician',onSignOut:signOut}:{})});
}
function lock() {
  const writable=ready && !ended && !closed && !leaving && !committed;
  for(const el of document.querySelectorAll('[data-command]')) {
    const lane=el.dataset.lane || 'write';el.disabled=!ready || ended || closed || leaving || Boolean(pending[lane]);
    if(lane==='write') el.disabled ||= !writable;
  }
  get('ask-question').disabled ||= !hasScope('vault:query');get('optional-check').disabled ||= !hasScope('affirmation:run');
  get('request-access').disabled ||= Boolean(allowance?.active_grants?.length);
  get('show-summary').disabled=!hasScope('summary:export') || Boolean(working.has('history'));
  for(const id of ['print-reviewed','download-reviewed']) if(get(id)) get(id).disabled=!hasScope('summary:export') || working.has('history');
  if(get('consultation-brief')) get('consultation-brief').disabled=!ready || committed || Boolean(pending.write);
  get('emergency-access').hidden=!actor?.permissions.includes('emergency:read');
  get('emergency-access').disabled ||= Boolean(allowance?.active_grants?.length);
  get('visit-note').disabled=!writable || pending.write?.kind==='commit';get('assessment').disabled=get('visit-note').disabled;
  get('note-language').disabled=!writable || Boolean(draft);
  get('save-draft').hidden=!dirty;get('save-draft').disabled ||= conflict;
  get('review-visit').disabled ||= conflict;
  get('simulated-scribe').disabled ||= conflict;
  get('confirm-review').disabled ||= dirty || !draft?.can_request_review;
  get('commit-record').disabled ||= dirty || draft?.state!=='REVIEWED' || !draft?.reviewed_payload_hash;
  get('show-original').disabled=!draft || !ready;get('load-draft').disabled=!ready || Boolean(pending.write);
  for(const button of document.querySelectorAll('.item-actions button')) button.disabled=!writable || pending.write?.kind==='commit';
}
function clearNotes() {
  revision+=1;draft=null;items=[];dirty=false;conflict=false;committed=false;needsDraft=true;
  itemBase=null;editingItem=-1;get('item-target').replaceChildren();
  get('visit-note').value='';get('assessment').value='';
  for(const id of ['medication-items','other-items','draft-warnings','simulation-label','review-content','review-feedback','item-fields','item-error','save-feedback']) get(id).replaceChildren();
  get('item-form').reset();get('simulation-label').hidden=true;renderDraftStatus();
  get('no-medicine').hidden=false;
}
function clearHistory() {
  historyEpoch+=1;history=null;historyDeadline=0;grantKey='';clearTimeout(expiryTimer);
  for(const id of ['allergies','history-groups','answer','question-feedback','check-result','source-content']) get(id).replaceChildren();
  get('answer').append(node('p','muted','Ask a supported question to see a sourced answer.'));
  get('question').value=localizedText('Penicillin allergy history?');get('history-content').hidden=true;dialogs.source.close();
  document.getElementById('encounter-print')?.replaceChildren();
  get('item-target').replaceChildren();
  // Source-linked edits are protected by the history grant, unlike new-care notes.
  if(items.some(item=>item.change_kind!=='INITIAL') || draft?.ai_proposal?.include_history) {dialogs.item.close();dialogs.review.close();clearNotes();}
  lock();
}
function clearPrivate() {
  generation+=1;ready=false;clearHistory();clearNotes();allowance=null;
  for(const dialog of Object.values(dialogs)) dialog.close();get('action-form').reset();get('action-fields').replaceChildren();actionSubmit=null;
  get('patient-name').textContent='Clinical Encounter';get('patient-meta').textContent='';get('access-status').textContent='Patient details hidden';
  get('encounter-workspace').hidden=true;get('request-region').hidden=true;lock();
}
function endSession(message) {
  ended=true;actor=null;clearTimeout(timer);for(const key of Object.keys(pending)) pending[key]=null;clearPrivate();header();showPending();
  notice('workspace-notice','Sign in to continue',message,'caution',{label:'Go to sign in',onClick:()=>location.replace('../login/')});
}
api.onContextClear(reason=>{
  if(reason==='NETWORK_UNAVAILABLE') {clearPrivate();needsSession=true;if(!ended && !leaving) notice('workspace-notice','Connection interrupted','Protected content and unsent edits have been cleared. Checking the server again…');showPending();}
  else if(['SESSION_ENDED','SESSION_EXPIRED','DATASET_CHANGED'].includes(reason)) {
    if(leaving) {clearPrivate();return;}
    endSession(reason==='DATASET_CHANGED'?'The dataset changed. Old requests and patient details have been cleared.':'Your session ended. Patient details and unsent edits have been cleared.');
  } else if(reason==='SESSION_CHANGED' && actor) endSession('The account changed. Return through sign in before continuing.');
});
function schedule() {clearTimeout(timer);if(!ended && !closed && !leaving && !document.hidden) timer=setTimeout(poll,2000);}
async function poll() {
  clearTimeout(timer);if(reading || working.has('write') || working.has('access') || ended || closed || leaving || document.hidden) {schedule();return;}
  reading=true;
  try {
    if(needsSession) {
      const result=await session.recover();if(ended || leaving) return;
      if(!result?.authenticated) {endSession('Use your assigned clinician account.');return;}
      if(result.actor.role==='PATIENT') {location.replace('../patient-visit/');return;}
      if(result.actor.role!=='CLINICIAN' || !result.actor.permissions.includes('clinical:write') || !result.actor.room_ids.includes(context.room_id)) {
        ended=true;clearPrivate();notice('workspace-notice','Encounter unavailable','Return to your permitted patient list.','caution',{label:'Patient list',onClick:()=>location.replace('../patients/')});return;
      }
      actor=result.actor;needsSession=false;header();
    }
    const epoch=generation;
    const room=await api.read(`/queue/rooms/${context.room_id}`);
    if(epoch!==generation || ended || leaving) return;
    if(room.version<roomVersion) return;roomVersion=room.version;
    const patient=room.current;
    if(!patient?.checked_in || patient.encounter_id!==context.encounter_id || patient.patient_id!==context.patient_id) {
      closed=true;clearPrivate();showPending();notice('workspace-notice','Encounter is no longer current','Retained unsaved drafts are not added to the clinical record. Return to the patient list; a new call is separate.','caution',{label:'Patient list',onClick:()=>location.replace('../patients/')});return;
    }
    const started=performance.now(),value=await api.read(`/encounters/${context.encounter_id}/allowance/status`);
    if(epoch!==generation || ended || leaving) return;
    ready=true;get('encounter-workspace').hidden=false;setText(get('patient-name'),patient.display_name);
    setText(get('patient-meta'),`Token ${patient.public_token} · ${room.label}`);get('workspace-notice').replaceChildren();
    applyAllowance(value,started);
    if(needsDraft && !dirty && !pending.write) await loadDraft();
    if(!history && hasScope('triage:read')) await loadHistory();
    lock();showPending();
    hideLoader();
  } catch(error) {
    if(!ended && !leaving) {clearPrivate();needsSession=true;notice('workspace-notice','Workspace unavailable','Protected content and unsent edits have been cleared. The page will check the server again.','caution',{label:'Try again',onClick:poll});showPending();}
  } finally {reading=false;schedule();}
}
function applyAllowance(value,started) {
  if(value.patient_id!==context.patient_id || value.encounter_id!==context.encounter_id) throw new Error('Context mismatch');
  const grant=value.active_grants?.find(item=>item.grant_state==='ACTIVE');
  const remaining=grant?Date.parse(grant.expires_at)-Date.parse(value.server_time):0;
  const key=grant?`${grant.grant_id}:${grant.mode}:${grant.scopes.join(',')}`:'';
  if(!grant || remaining<=0) {
    if(grantKey || history) clearHistory();allowance=value;get('history-content').hidden=true;setText(get('access-status'),'History not shared');
    const request=value.request,state=request?.request_state;
    const title=state==='CLARIFICATION_REQUESTED'?'Patient asked why':state==='REQUESTED'?'Waiting for the patient’s choice':state==='DENIED'?'History sharing declined':'History is not shared';
    const copy=state==='CLARIFICATION_REQUESTED'?request.clarification_note || 'Explain the purpose to the patient.':
      state==='REQUESTED'?'The request lasts up to five minutes and ends if you sign out. The patient can respond on their device, or permitted staff can assist. New care can continue.':'Request sharing only when needed for this consultation. New care can continue without it.';
    notice('history-access',title,copy,'neutral');get('request-region').hidden=false;
    setText(get('request-access'),state==='CLARIFICATION_REQUESTED'?'Explain why':state==='REQUESTED'?'View sharing request':'Request history sharing');
  } else {
    if(key!==grantKey) clearHistory();
    historyDeadline=key===grantKey?Math.min(historyDeadline,started+remaining):started+remaining;grantKey=key;allowance=value;
    clearTimeout(expiryTimer);expiryTimer=setTimeout(()=>{
      clearHistory();setText(get('access-status'),'History sharing ended');notice('history-access','History sharing ended','Previously displayed history and answers have been cleared. New care can continue.');get('request-region').hidden=false;
    },Math.max(0,historyDeadline-performance.now()));
    setText(get('access-status'),`${grant.mode==='BREAK_GLASS'?'Emergency access':'History shared'} until ${new Date(grant.expires_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`);
    get('request-region').hidden=true;
    if(grant.mode==='BREAK_GLASS') notice('history-access','Emergency access · simulated registration','Limited to history and visit questions. This does not permit exports or clinical safety checks.','caution');
    else get('history-access').replaceChildren();
    get('history-content').hidden=!hasScope('triage:read');
  }
  lock();
}
async function loadHistory() {
  if(!hasScope('triage:read')) return;
  const epoch=generation,access=historyEpoch;
  try {
    const value=await api.read(`/vault/patient/${context.patient_id}/active-state`,{encounter_id:context.encounter_id});
    if(epoch!==generation || access!==historyEpoch || !hasScope('triage:read')) return;
    if(value.authorization_state!=='AUTHORIZED' || !value.clinical_data) {clearHistory();return;}
    history=value;renderHistory();
  } catch(error) {
    if(epoch!==generation || ended) return;
    clearHistory();notice('history-access','History unavailable','No clinical history is being shown. New-care notes remain independent.');
  }
}
function eventName(event) {return event.payload?.concept?.text || event.payload?.scope_text || event.payload?.reason || names[event.event_type];}
function eventDetail(event) {
  const p=event.payload || {};return [p.statement_kind,p.status || p.clinical_status,p.verification_status].filter(Boolean).map(human).join(' · ');
}
function showSource(event,citation) {
  if(!hasScope('triage:read') && !hasScope('vault:query')) return;
  setText(get('source-title'),'Recorded source');const body=get('source-content');body.replaceChildren(node('h3','section-label',eventName(event)));
  const source=citation || {source_kind:event.source?.kind,source_author:event.source?.original_author,source_date:event.source?.authored_on,recorded_at:event.recorded_at,occurred_on:event.occurred_on,review_status:event.review?.status};
  body.append(node('p','source-copy',eventDetail(event)),detailsList([['Source',human(source.source_kind)],['Original author',source.source_author],['Source date',source.source_date],['Occurrence',source.occurred_on || event.occurrence_text],['Recorded',source.recorded_at],['Review',human(source.review_status)]]));
  for(const [key,value] of Object.entries(event.payload || {})) if(value!==null && typeof value!=='object') body.append(node('p','source-copy',`${human(key)}: ${value}`));
  body.append(node('p','source-copy',event.source?.quote || 'A full original note is not returned by this view.'));
  dialogs.source.open();
}
function recordEntry(event) {
  const el=node('div','record-entry');el.append(node('p','record-entry-title',eventName(event)),node('p','',eventDetail(event)),node('p','record-meta',`Source: ${event.source?.authored_on || 'date not recorded'} · ${event.source?.original_author || human(event.source?.kind)}`));
  if(event.review?.status==='FIXTURE_NOT_CLINICALLY_VALIDATED') el.append(node('p','field-help','Fictional fixture · not clinically validated'));
  el.append(textButton('View source',()=>showSource(event)));return el;
}
function renderHistory() {
  const data=history.clinical_data,allergies=get('allergies');allergies.replaceChildren(node('h3','section-label','Allergies'));
  if(data.allergies.length) for(const event of data.allergies) {
    const warning=createNotice({tone:'danger',title:eventName(event),message:`${eventDetail(event)} · Source: ${event.source.authored_on || 'date not recorded'}`});
    if(event.review.status==='FIXTURE_NOT_CLINICALLY_VALIDATED') warning.querySelector('.notice-copy').append(node('p','field-help','Fictional fixture · not clinically validated'));
    warning.querySelector('.notice-copy').append(textButton('View source',()=>showSource(event)));allergies.append(warning);
  } else allergies.append(node('p','muted','No allergy statement recorded in this vault. This is not a negative allergy assessment.'));
  const groups=get('history-groups');groups.replaceChildren();
  for(const [key,label] of [['medications','Recorded medicines'],['conditions','Conditions'],['procedures','Procedures'],['negative_findings','Dated negative findings']]) {
    const section=node('section');section.append(node('h3','section-label',label));
    if(data[key].length) section.append(...data[key].map(recordEntry));else section.append(node('p','muted','No statement recorded in this vault.'));
    groups.append(section);
  }
  for(const warning of data.warnings || []) groups.append(node('p','field-help',warning==='POSSIBLE_DUPLICATE_SEPARATE_ENTITY_THREADS'?'Possible duplicates are separate clinical statements; they have not been merged.':warning));
  get('history-content').hidden=false;
}
function renderAnswer(value) {
  const body=get('answer');body.replaceChildren(node('p','field-help',`Question: ${value.question_text}`),node('p','state-label',value.certainty_state?human(value.certainty_state):`${human(value.lookup_status)} · no certainty verdict`),node('p','',value.answer_text));
  if(value.ai_status) body.append(node('p','field-help',value.generation_mode==='LOCAL_FALLBACK'?'Text interpretation unavailable; the exact local question was used.':`Optional text interpretation selected ${human(value.interpreted_topic)}. The cited evidence and certainty come from the local record rules.`));
  for(const warning of value.warnings || []) body.append(node('p','field-help',warning));
  for(const citation of value.source_citations || []) {
    const fact=value.facts.find(item=>item.event_id===citation.event_id),row=node('div','record-entry');
    row.append(node('p','record-entry-title',eventName(fact)),node('p','',eventDetail(fact)),node('p','record-meta',`${citation.source_date || 'Source date not recorded'} · ${citation.source_author || human(citation.source_kind)}`),textButton('View source',()=>showSource(fact,citation)));body.append(row);
    if(citation.review_status==='FIXTURE_NOT_CLINICALLY_VALIDATED') row.append(node('p','field-help','Fictional fixture · not clinically validated'));
  }
  get('question-feedback').replaceChildren();
}
function noteText() {return `Visit note:\n${get('visit-note').value}\n\nAssessment:\n${get('assessment').value}`;}
function noteParts(text) {
  const prefix='Visit note:\n',divider='\n\nAssessment:\n',index=text.indexOf(divider,prefix.length);
  return text.startsWith(prefix) && index>=0?[text.slice(prefix.length,index),text.slice(index+divider.length)]:[text,''];
}
function markDirty() {revision+=1;dirty=true;get('save-feedback').replaceChildren();renderDraftStatus();lock();}
function renderDraftStatus() {
  const badge=committed?'Reviewed record saved':dirty?'Unsaved changes':draft?.state==='REVIEWED'?'Reviewed · not committed':draft?'Draft · review needed':'New note';setText(get('draft-badge'),badge);
  get('save-status').replaceChildren(node('p','',committed?'Reviewed record saved':dirty?'Unsaved changes':draft?'Draft saved to hospital server':'Not saved to hospital server'),node('p','muted',committed?'Encounter completion is a separate action':'Not added to the clinical record'));
  get('simulation-label').hidden=!draft?.simulation_label;
  if(draft?.simulation_label) notice('simulation-label','Simulated scribe',draft.simulation_label,'info');
}
function renderItems() {
  get('medication-items').replaceChildren();get('other-items').replaceChildren();
  items.forEach((item,index)=>{
    const row=node('div','draft-item');row.append(node('p','record-entry-title',`${names[item.event_type]} · ${eventName(item)}`),node('p','record-meta',`${human(item.change_kind)} · ${eventDetail(item)}`));
    const actions=node('div','item-actions');actions.append(textButton('Edit',()=>openItem(item.event_type,index)),textButton('Remove from draft',()=>{
      if(!ready || committed || pending.write?.kind==='commit') return;items.splice(index,1);markDirty();renderItems();
    }));if(!committed) row.append(actions);
    get(item.event_type==='MEDICATION_RECORDED'?'medication-items':'other-items').append(row);
  });get('no-medicine').hidden=items.some(item=>item.event_type==='MEDICATION_RECORDED');
  get('draft-warnings').replaceChildren();
  if(!dirty) for(const warning of draft?.warnings || []) get('draft-warnings').append(node('p','field-help',warning.message));
}
function acceptDraft(value,expectedRevision=revision) {
  if(!value || value.encounter_id!==context.encounter_id || (draft && value.version<draft.version)) return;
  draft=value;needsDraft=false;committed=value.state==='COMMITTED';
  if(revision===expectedRevision) {
    items=structuredClone(value.items);const parts=noteParts(value.text);get('visit-note').value=parts[0];get('assessment').value=parts[1];dirty=false;conflict=false;
    get('note-language').value=value.language;
  } else dirty=true;
  renderItems();renderDraftStatus();lock();
}
async function loadDraft({replace=false}={}) {
  if(!ready || ended || closed || leaving) return;
  const epoch=generation,rev=revision;
  try {
    const value=await api.read(`/encounters/${context.encounter_id}/draft`);
    if(epoch!==generation || !ready) return;
    if(value.draft) acceptDraft(value.draft,rev);
    else {needsDraft=false;if(rev===revision && (!dirty || replace)) {clearNotes();needsDraft=false;}}
  } catch(error) {
    if(epoch!==generation || ended) return;
    needsDraft=false;conflict=true;notice('save-feedback','Draft unavailable','The stored draft could not be loaded. Load the current draft before saving. History-linked drafts require current sharing.');lock();
  }
}
function showPending() {
  const region=get('pending-commands'),entries=Object.entries(pending).filter(([lane,value])=>value && !working.has(lane));
  const key=entries.map(([lane,value])=>`${lane}:${value.intent.key}`).join(',');
  if(region.dataset.pendingKey===key && (region.childElementCount || !key)) return;
  region.dataset.pendingKey=key;region.replaceChildren(...entries.map(([lane,value])=>createNotice({title:`${value.label}: outcome not confirmed`,message:'Keep this page open. Check the original command; do not repeat it as a new action.',tone:'caution',action:{label:'Check outcome',onClick:()=>execute(lane)}})));
}
function errorMessage(error) {
  return ({UNSUPPORTED_QUESTION:'Choose one of the six supported questions. Other wording is not supported by the current local rules.',
    ASR_MODE_UNAVAILABLE:'Simulated scribe is unavailable. Manual notes remain available.',AI_UNAVAILABLE:'Optional text assistance is unavailable. Manual notes and exact supported questions remain available.',AI_CONTEXT_CHANGED:'The source note changed. Save the current draft before requesting another proposal.',AI_BUDGET_EXHAUSTED:'The configured text-assistance limit has been reached. Manual care remains available.',AI_OUTCOME_UNKNOWN:'The earlier text attempt cannot be safely repeated. Use manual notes or an exact local question.',AI_PROVIDER_UNAVAILABLE:'Text assistance did not complete. No automatic provider retry was made. Manual notes and exact local questions remain available.',AI_OUTPUT_INVALID:'The text proposal could not be validated. The saved note is unchanged.',REVIEW_VALIDATION_FAILED:'Complete the clinical statements and their source details, save the draft, then review again.',
    DRAFT_VERSION_CONFLICT:'This draft changed on the server. Load the current draft before choosing another save.',STATE_VERSION_CONFLICT:'The source changed. Refresh the history and current draft before continuing.',
    SUMMARY_NOT_COMMITTED:'No reviewed record has been committed for this encounter.',SUMMARY_OUTDATED:'A source statement was corrected or retracted. The earlier summary is no longer available.',
    CLINICAL_INTEGRITY_INVALID:'The clinical source could not be verified. No protected result is being shown.',HISTORY_LOCKED:'History is not shared for this action.',GRANT_ENDED:'History sharing ended. Previously displayed history has been cleared.',
    SCOPE_DENIED:'The current authorization does not permit this action.',RESOURCE_UNAVAILABLE:'This item is unavailable for the current account or encounter.',VALIDATION_ERROR:'Check the note, clinical item and source fields. The server did not accept the submitted values.'})[error.code] ||
    (error.status===429?'The server is limiting requests. Wait before trying again.':'The server did not complete this action. Review the current state before trying again.');
}
async function command(kind,path,body,label) {
  const lane=laneFor(kind);if(pending[lane] || !ready || ended || closed || leaving) return null;
  try {pending[lane]={kind,intent:api.createIntent(path,body),label,revision,generation};return await execute(lane);}
  catch(error) {notice('save-feedback','Request not sent',errorMessage(error));return null;}
}
async function execute(lane) {
  const work=pending[lane];if(!work || working.has(lane) || ended || leaving) return null;
  working.add(lane);lock();showPending();const epoch=generation,access=historyEpoch,requestStarted=performance.now();
  const target=lane==='history'?'question-feedback':lane==='access'?'history-access':'save-feedback';notice(target,`${work.label}…`,'Waiting for the server.','info');
  try {
    const value=await api.command(work.intent);if(pending[lane]!==work || ended || leaving) return null;
    pending[lane]=null;
    if(work.kind==='commit') {
      committed=true;dirty=false;dialogs.review.close();notice('save-feedback','Reviewed record saved','The record was committed. Summary access and encounter completion remain separate.','success');announce('Reviewed record saved.');
      if(closed) notice('workspace-notice','Reviewed record saved','The original commit is confirmed. This encounter is no longer current; return to the patient list.','success',{label:'Patient list',onClick:()=>location.replace('../patients/')});
      if(draft) draft={...draft,state:'COMMITTED'};renderDraftStatus();renderItems();
    } else if(epoch===generation && !closed && ready) {
      if(lane==='write') {
        if(value.draft) acceptDraft(value.draft,work.generation!==generation && !dirty?revision:work.revision);else {needsDraft=true;await loadDraft();}
        notice('save-feedback',dirty?'Earlier draft saved':work.kind==='review'?'Ready to save reviewed record':'Draft saved to hospital server',dirty?'Newer edits are still unsent. The saved draft has not been added to the clinical record.':'Not added to the clinical record.','success');
        if(work.kind==='review' && dialogsReviewOpen()) renderReview();
      } else if(work.kind==='query' && access===historyEpoch && hasScope('vault:query')) renderAnswer(value);
      else if(work.kind==='check' && access===historyEpoch && hasScope('affirmation:run')) notice('check-result','Optional check · not evaluated',[...(value.unsupported_areas || []),...(value.warnings || [])].join(' '),'neutral');
      else if(lane==='access') {if(value.allowance) applyAllowance({...value.allowance,server_time:value.server_time},requestStarted);}
    } else needsDraft=true;
    return epoch===generation && !closed?value:null;
  } catch(error) {
    if(pending[lane]!==work || ended || leaving) return null;
    if(error.commit_state==='UNKNOWN' || error.retry_strategy==='SAME_KEY') {notice(target,`${work.label}: outcome not confirmed`,'Use Check outcome above.');}
    else {
      api.forget(work.intent);pending[lane]=null;
      if(['HISTORY_LOCKED','GRANT_ENDED','SCOPE_DENIED'].includes(error.code)) clearHistory();
      if(error.code==='CLINICAL_INTEGRITY_INVALID') {clearHistory();notice('history-access','History unavailable','The clinical source could not be verified. No history or previous answer is being shown.');}
      if(['DRAFT_VERSION_CONFLICT','STATE_VERSION_CONFLICT'].includes(error.code) && lane==='write') conflict=true;
      notice(target,`${work.label} not completed`,errorMessage(error));
      if(dialogsReviewOpen()) notice('review-feedback','Review/save not completed',errorMessage(error));
    }
    if(work.kind==='query' && ready) get('answer').replaceChildren(node('p','muted','No confirmed answer is being shown for this question.'));
    return null;
  } finally {working.delete(lane);lock();showPending();schedule();}
}
function dialogsReviewOpen() {return get('review-dialog').open;}
async function saveDraft() {
  if(!ready || conflict || committed || pending.write) return false;
  if(!get('visit-note').value.trim() && !get('assessment').value.trim()) {setFieldError(get('visit-note'),get('note-error'),'Enter a visit note or assessment.');get('visit-note').focus();return false;}
  const text=noteText();if(text.length>8000) {setFieldError(get('visit-note'),get('note-error'),'The combined visit note and assessment must fit within 8,000 characters.');return false;}
  setFieldError(get('visit-note'),get('note-error'),'');const epoch=generation,rev=revision,selectedItems=structuredClone(items);
  if(!draft) {
    const result=await command('capture','/scribe/transcribe',{encounter_id:context.encounter_id,input_mode:'MANUAL_TEXT',language:get('note-language').value,text},'Save draft');
    if(!result || epoch!==generation || rev!==revision || !draft) return false;
    // Manual capture has no automatic items; retain only the clinician's explicit entries.
    if(selectedItems.length) {items=selectedItems;dirty=true;}
  }
  if(dirty) {
    const result=await command('save',`/scribe/drafts/${draft.draft_id}/save`,{expected_draft_version:draft.version,text,items:structuredClone(items)},'Save draft');
    if(!result || epoch!==generation || rev!==revision) return false;
  }
  return Boolean(draft && !dirty);
}
function renderReview() {
  const body=get('review-content');body.replaceChildren();if(!draft) return;
  body.append(node('h3','section-label','Stored visit note and assessment'),node('p','review-note',draft.text));
  if(draft.simulation_label) body.append(createNotice({tone:'info',title:'Simulated source',message:draft.simulation_label}));
  body.append(node('h3','section-label',`Clinical statements (${draft.items.length})`));
  for(const item of draft.items) body.append(itemReview(item));
  for(const warning of draft.warnings) body.append(node('p','field-help',warning.message));
  if(!draft.items.length) body.append(node('p','field-error','No structured clinical items. Close review and add supported statements before confirming.'));
  notice('review-feedback',draft.state==='REVIEWED'?'Ready to save reviewed record':'Review needed',draft.state==='REVIEWED'?'This exact stored version has been reviewed. It is not yet committed.':'Check every statement and source before confirming.','neutral');lock();
}
function itemReview(item) {
  const section=node('section','record-entry');section.append(node('h3','section-label',`${names[item.event_type]} · ${eventName(item)}`));
  const fields=Object.entries(item.payload || {}).flatMap(([key,value])=>key==='concept'?[[names[item.event_type],value?.text]]:key==='scope'?[[human(key),value?`${human(value.topic_key)} · ${human(value.timeframe)}`:null]]:[[human(key),value]]);
  section.append(detailsList([...fields,['Record action',human(item.change_kind)],['Reason for change',item.change_reason],['Occurrence date',item.occurred_on],['Occurrence description',item.occurrence_text],['Source',human(item.source.kind)],['Source reference',item.source.reference],['Source date',item.source.authored_on],['Original source author',item.source.original_author],['Supporting quote',item.source.quote]]));return section;
}

// Only the six API statement families are exposed. Blank optional values remain null.
const definition={
  MEDICATION_RECORDED:[['statement_kind','Statement',['PRESCRIBED','REPORTED_TAKING','ADMINISTERED']],['status','Status',['ACTIVE','COMPLETED','DISCONTINUED','UNKNOWN']],['dose_text','Dose',200],['route_text','Route',200],['frequency_text','Frequency',200],['duration_text','Duration',200],['reason','Reason',500]],
  CONDITION_RECORDED:[['clinical_status','Clinical status',['ACTIVE','RESOLVED','UNKNOWN']],['verification_status','Verification',['UNCONFIRMED','CONFIRMED']]],
  ALLERGY_RECORDED:[['clinical_status','Clinical status',['ACTIVE','INACTIVE','RESOLVED','UNKNOWN']],['verification_status','Verification',['UNCONFIRMED','CONFIRMED']],['reaction_text','Reaction',500],['reaction_severity','Reaction severity',['UNKNOWN','MILD','MODERATE','SEVERE']]],
  PROCEDURE_RECORDED:[['status','Status',['UNKNOWN','REPORTED_COMPLETED','COMPLETED']],['note','Supporting note',500]],
  NEGATIVE_FINDING_RECORDED:[['topic_key','Assessment topic',topics],['declared_on','Assessment date','date'],['declared_by','Document declarer (document sources only)',128],['clinical_basis','Clinical basis',500],['scope_text','Assessment scope',500]],
  RECORD_RETRACTED:[],
};
let itemBase=null;
function field(parent,id,label,kind,value='') {
  const wrapper=node('div','field'),caption=node('label','field-label',label);caption.htmlFor=id;
  const control=node(Array.isArray(kind)?'select':Number(kind)>=500?'textarea':'input','field-control');control.id=id;
  if(Array.isArray(kind)) for(const option of kind) {const el=node('option','',human(option));el.value=option;control.append(el);}
  else if(kind==='date') control.type='date';else control.maxLength=Number(kind);
  control.value=value || (Array.isArray(kind)?kind[0]:'');wrapper.append(caption,control);parent.append(wrapper);return control;
}
function allTips() {return history?.clinical_data?['medications','conditions','allergies','procedures','negative_findings'].flatMap(key=>history.clinical_data[key]):[];}
function targetOptions() {
  const type=get('item-type').value,select=get('item-target'),previous=select.value;
  select.replaceChildren(node('option','','Choose a recorded statement'));select.firstChild.value='';
  for(const event of allTips().filter(value=>type==='RECORD_RETRACTED' || value.event_type===type)) {
    const option=node('option','',`${eventName(event)} · ${event.source.authored_on || 'date not recorded'}`);option.value=event.event_id;select.append(option);
  }
  select.value=previous;
}
function itemFields(payload={}) {
  const type=get('item-type').value,region=get('item-fields');region.replaceChildren();
  if(!['NEGATIVE_FINDING_RECORDED','RECORD_RETRACTED'].includes(type)) field(region,'item-concept',`${names[type]} name`,200,payload.concept?.text);
  for(const [key,label,kind] of definition[type]) {
    const value=key==='topic_key'?payload.scope?.topic_key:payload[key],control=field(region,`payload-${key}`,label,kind,value);
    if(Array.isArray(kind)) {const blank=node('option','','Not recorded');blank.value='';control.prepend(blank);control.value=value || '';}
  }
  if(type==='MEDICATION_RECORDED') region.append(node('p','field-help','An active prescription needs dose, route and frequency. A reported medicine is not proof of current ingestion.'));
  if(type==='NEGATIVE_FINDING_RECORDED') region.append(node('p','field-help','This is an explicit, dated assessment within its stated scope. Missing documentation cannot be entered as a negative finding.'));
}
function itemTransition() {
  let change=get('item-change').value;
  if(get('item-type').value==='RECORD_RETRACTED') {change='RETRACTION';get('item-change').value=change;}
  else if(change==='RETRACTION') {get('item-type').value='RECORD_RETRACTED';itemFields();}
  get('target-region').hidden=change==='INITIAL';targetOptions();
}
function openItem(type='CONDITION_RECORDED',index=-1) {
  if(!ready || committed || pending.write?.kind==='commit') return;
  const returnFocus=get('more-tools').contains(document.activeElement)?get('more-tools').querySelector('summary'):document.activeElement;
  get('more-tools').open=false;editingItem=index;itemBase=index>=0?structuredClone(items[index]):null;
  get('item-form').reset();get('item-error').hidden=true;get('item-type').value=itemBase?.event_type || type;
  get('item-type').disabled=index>=0;get('item-change').value=itemBase?.change_kind || (type==='RECORD_RETRACTED'?'RETRACTION':'INITIAL');
  get('item-change').disabled=index>=0;itemFields(itemBase?.payload);itemTransition();
  if(itemBase?.supersedes_event_id) get('item-target').value=itemBase.supersedes_event_id;
  get('item-reason').value=itemBase?.change_reason || '';
  const source=itemBase?.source;
  get('item-source').value=source?.kind || 'CLINICIAN_ASSESSMENT';get('source-reference').value=source?.reference || '';
  get('source-author').value=source?.original_author || '';get('source-date').value=source?.authored_on || '';
  get('occurred-on').value=itemBase?.occurred_on || '';get('occurrence-text').value=itemBase?.occurrence_text || '';get('source-quote').value=source?.quote || '';
  dialogs.item.open(returnFocus);
}
get('item-type').addEventListener('change',()=>{itemFields();itemTransition();});
get('item-change').addEventListener('change',itemTransition);
get('item-target').addEventListener('change',()=>{
  const target=allTips().find(event=>event.event_id===get('item-target').value);
  if(target) itemFields(get('item-type').value==='RECORD_RETRACTED'?{}:target.payload);
});
get('item-form').addEventListener('submit',event=>{
  event.preventDefault();if(!ready || committed || pending.write?.kind==='commit') return;
  const fail=message=>{setText(get('item-error'),message);get('item-error').hidden=false;};
  const type=get('item-type').value,change=get('item-change').value,target=allTips().find(item=>item.event_id===get('item-target').value);
  const nullable=id=>get(id).value.trim() || null,payload={};
  if(change!=='INITIAL' && (!hasScope('triage:read') || !target || !nullable('item-reason'))) {fail('Choose a currently shared source statement and enter a reason for the change.');return;}
  if(items.length>=20 && editingItem<0) {fail('This draft already has 20 clinical statements.');return;}
  const invalidDate=['source-date','occurred-on',...(type==='NEGATIVE_FINDING_RECORDED'?['payload-declared_on']:[])].some(id=>get(id).validity.badInput);
  if(invalidDate) {fail('Enter valid dates, or leave an unknown date blank.');return;}
  if(get('item-source').value==='DOCUMENT_REFERENCE' && (!nullable('source-reference') || !/^[A-Za-z0-9_-]{1,128}$/u.test(nullable('source-reference')))) {fail('Enter the existing document/reference identifier.');return;}
  const quote=nullable('source-quote');if(quote && !noteText().includes(quote)) {fail('The supporting quote must appear exactly in the visit note or assessment.');return;}
  if(!['NEGATIVE_FINDING_RECORDED','RECORD_RETRACTED'].includes(type)) {
    const text=nullable('item-concept'),baseConcept=itemBase?.payload.concept || target?.payload.concept;
    payload.concept=text?{text,term_key:text===baseConcept?.text?baseConcept.term_key:null,coding:null}:null;
  }
  for(const [key] of definition[type]) payload[key]=nullable(`payload-${key}`);
  if(type==='NEGATIVE_FINDING_RECORDED') {
    payload.scope={topic_key:payload.topic_key,timeframe:'AT_ASSESSMENT'};delete payload.topic_key;
    if(get('item-source').value!=='DOCUMENT_REFERENCE') payload.declared_by=get('item-source').value==='PATIENT_REPORT'?context.patient_id:actor.account_id;
  }
  if(type==='RECORD_RETRACTED') payload.reason=nullable('item-reason');
  const item={event_type:type,entity_id:change==='INITIAL'?(itemBase?.entity_id ?? null):target.entity_id,change_kind:change,
    change_reason:change==='INITIAL'?null:nullable('item-reason'),supersedes_event_id:change==='INITIAL'?null:target.event_id,
    occurred_on:type==='NEGATIVE_FINDING_RECORDED'?payload.declared_on:nullable('occurred-on'),occurrence_text:nullable('occurrence-text'),
    source:{kind:get('item-source').value,reference:nullable('source-reference'),authored_on:nullable('source-date'),original_author:nullable('source-author'),quote},payload};
  if(editingItem>=0) items[editingItem]=item;else items.push(item);
  itemBase=null;dialogs.item.close();markDirty();renderItems();
});

function action(title,copy,build,submit,label='Continue') {
  if(!ready || ended || closed || leaving) return;
  const returnFocus=get('more-tools').contains(document.activeElement)?get('more-tools').querySelector('summary'):document.activeElement;
  get('more-tools').open=false;setText(get('action-title'),title);setText(get('action-copy'),copy);get('action-fields').replaceChildren();get('action-error').hidden=true;setText(get('action-submit'),label);
  build(get('action-fields'));actionSubmit=submit;dialogs.action.open(returnFocus);
}
get('action-form').addEventListener('submit',event=>{event.preventDefault();if(!actionSubmit || !ready) return;actionSubmit();});
function actionError(message) {setText(get('action-error'),message);get('action-error').hidden=false;}
function sharingAction() {
  const request=allowance?.request,state=request?.request_state;
  if(state==='REQUESTED') {
    action('Sharing request','The patient may Allow, Deny or Ask why. The requesting clinician cannot approve this request.',region=>{
      region.append(node('p','source-copy',request.explanation),node('p','muted',`Request ends: ${new Date(request.expires_at).toLocaleTimeString()}`));
    },()=>dialogs.action.close(),'Close');return;
  }
  action(state==='CLARIFICATION_REQUESTED'?'Explain why':'Request history sharing',
    'Explain why access is needed for this visit. The normal request covers recorded history, visit questions, optional checks and a copy of the reviewed summary, for up to 15 minutes. The patient’s choice does not change queue priority.',
    region=>{
      if(request?.clarification_note) region.append(createNotice({tone:'neutral',title:'Patient’s question',message:request.clarification_note}));
      field(region,'sharing-explanation','Purpose of access',500,state==='CLARIFICATION_REQUESTED'?request.explanation:'');
    },async()=>{
      const explanation=get('sharing-explanation').value.trim();if(!explanation) {actionError('Enter the reason for requesting access.');return;}
      dialogs.action.close();
      if(state==='CLARIFICATION_REQUESTED') await command('clarify',`/encounters/${context.encounter_id}/allowance/clarify`,{consent_request_id:request.consent_request_id,expected_request_version:request.request_version,explanation},'Explain sharing request');
      else await command('request',`/encounters/${context.encounter_id}/allowance/request`,{explanation},'Request history sharing');
      void poll();
    },state==='CLARIFICATION_REQUESTED'?'Send explanation':'Request sharing');
}
get('request-access').addEventListener('click',sharingAction);
get('simulated-scribe').addEventListener('click',()=>action('Simulated scribe',
  'Predefined offline text; no audio is processed. Using a template replaces this encounter’s current draft text and items, including unsaved edits. It does not save a clinical record.',
  region=>field(region,'scribe-fixture','Offline template',[
    'hindi_clip_1_dyspepsia','hindi_clip_2_bp_sugar','hindi_clip_3_scribe']),
  async()=>{
    const fixture_id=get('scribe-fixture').value;dialogs.action.close();
    await command('capture','/scribe/transcribe',{encounter_id:context.encounter_id,input_mode:'MOCK_FIXTURE',language:'hi',fixture_id,...(draft?{expected_draft_version:draft.version}:{})},'Simulated scribe');
  },'Use template'));
get('optional-check').addEventListener('click',()=>action('Optional check',
  'No sourced, clinician-reviewed interaction rules are active. The current check reports NOT_EVALUATED; it gives no clinical safety verdict and is not required for saving.',
  region=>{field(region,'check-type','Intervention type',['MEDICATION','PROCEDURE','DIAGNOSTIC']);field(region,'check-items','Planned items (one per line, up to 20)',4000);},
  async()=>{
    const planned_items=get('check-items').value.split('\n').map(text=>text.trim()).filter(Boolean);
    if(!planned_items.length || planned_items.length>20 || planned_items.some(text=>text.length>200)) {actionError('Enter 1–20 items, each at most 200 characters.');return;}
    const intervention_type=get('check-type').value;dialogs.action.close();await command('check','/vault/affirmation',{...contextForClinical(),intervention_type,planned_items},'Optional check');
  },'Run optional check'));
get('emergency-access').addEventListener('click',()=>action('Emergency access',
  'Use only for an actual emergency under the authorized workflow. Demo registration checking is simulated. A durable audit must be saved before history access. This permits no export and does not replace urgent care.',
  region=>field(region,'emergency-reason','Reason for emergency access',1000),async()=>{
    const reason=get('emergency-reason').value.trim();if(!reason) {actionError('Enter the reason for emergency access.');return;}
    dialogs.action.close();await command('emergency',`/encounters/${context.encounter_id}/break-glass`,{reason},'Emergency access');void poll();
  },'Request emergency access'));
get('load-draft').addEventListener('click',()=>{
  get('more-tools').open=false;
  if(!dirty) {void loadDraft({replace:true});return;}
  action('Load current draft','Loading replaces the unsent text and items in this page with the server’s current draft. Unsent changes will be discarded.',()=>{},async()=>{dialogs.action.close();await loadDraft({replace:true});},'Discard unsent changes and load');
});
get('show-original').addEventListener('click',()=>{
  if(!draft || !ready) return;get('more-tools').open=false;setText(get('source-title'),'Original captured source');
  get('source-content').replaceChildren(node('p','field-help',draft.simulation_label || 'Manual input. No automatic clinical items were extracted.'),node('p','source-copy',draft.original_text));dialogs.source.open(get('more-tools').querySelector('summary'));
});
get('show-summary').addEventListener('click',async()=>{
  if(!hasScope('summary:export') || working.has('history')) return;
  get('more-tools').open=false;const epoch=generation,access=historyEpoch;working.add('history');lock();
  try {
    const value=await api.read(`/encounters/${context.encounter_id}/summary`);
    if(epoch!==generation || access!==historyEpoch || !hasScope('summary:export')) return;
    setText(get('source-title'),'Reviewed visit summary');const body=get('source-content');body.replaceChildren(node('p','field-help','Fictional record · committed encounter batch only'),node('p','source-copy',value.reviewed_text));
    for(const statement of value.statements || []) body.append(node('p','source-copy',statement.display_text));
    body.append(node('p','field-help','Official FHIR validation: NOT_RUN. This is the committed reviewed encounter batch.'));dialogs.source.open(get('more-tools').querySelector('summary'));
  } catch(error) {if(epoch===generation && !ended) notice('save-feedback','Summary unavailable',errorMessage(error));}
  finally {working.delete('history');lock();}
});
function contextForClinical() {return {patient_id:context.patient_id,encounter_id:context.encounter_id};}
get('question-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!hasScope('vault:query') || pending.history) return;
  const entered=get('question').value.trim(),text=questions.find(question=>entered===question||entered===hindiText(question))??entered;setFieldError(get('question'),get('question-error'),text?'':'Enter a supported question.');
  if(!text) {get('question').focus();return;}
  get('answer').replaceChildren(node('p','muted','Waiting for the answer…'));
  const interpret=get('interpret-question').checked;
  await command('query',interpret?'/ai/records/ask':'/vault/query',interpret?{encounter_id:context.encounter_id,question:text}:{...contextForClinical(),question_text:text},'Ask record');
});
get('refresh-history').addEventListener('click',()=>{history=null;void loadHistory();});
get('visit-note').addEventListener('input',markDirty);get('assessment').addEventListener('input',markDirty);
get('add-medicine').addEventListener('click',()=>openItem('MEDICATION_RECORDED'));
get('add-statement').addEventListener('click',()=>openItem());
get('save-draft').addEventListener('click',()=>{void saveDraft();});
get('review-visit').addEventListener('click',async()=>{
  const epoch=generation;if(!(await saveDraft()) || epoch!==generation || dirty || !ready || pending.write) return;
  renderReview();dialogs.review.open(get('review-visit'));
});
get('confirm-review').addEventListener('click',async()=>{
  if(!draft || dirty || !draft.can_request_review) return;
  await command('review',`/scribe/drafts/${draft.draft_id}/review`,{expected_draft_version:draft.version,review_confirmed:true},'Confirm review');
});
get('commit-record').addEventListener('click',async()=>{
  if(!draft || dirty || draft.state!=='REVIEWED' || !draft.reviewed_payload_hash) return;
  await command('commit','/scribe/commit',{draft_id:draft.draft_id,expected_draft_version:draft.version,reviewed_payload_hash:draft.reviewed_payload_hash},'Save reviewed record');
});
async function signOut() {
  if(logoutWorking) return;
  if(!leaving) {leaving=true;clearTimeout(timer);clearPrivate();}
  logoutIntent ??=api.createIntent('/auth/logout',{});logoutWorking=true;notice('workspace-notice','Signing out…','Patient details and unsent edits have been cleared.','info');
  try {await api.command(logoutIntent);api.clear('SESSION_ENDED');location.replace('../login/');}
  catch(error) {
    if(error.status===401 || ['INTENT_INVALIDATED','DATASET_CHANGED'].includes(error.code)) {location.replace('../login/');return;}
    const uncertain=error.commit_state==='UNKNOWN' || error.retry_strategy==='SAME_KEY';if(!uncertain) logoutIntent=null;
    notice('workspace-notice','Sign-out not confirmed','Patient details remain hidden. Check sign-out with the server.','caution',{label:uncertain?'Check sign-out':'Try sign-out again',onClick:signOut});
  } finally {logoutWorking=false;}
}
document.addEventListener('visibilitychange',()=>{
  if(document.hidden) {clearTimeout(timer);clearPrivate();needsSession=true;}
  else if(!ended && !closed && !leaving) void poll();
});
window.addEventListener('pagehide',()=>{clearTimeout(timer);clearPrivate();api.clear('PAGE_LEFT');});
window.addEventListener('pageshow',event=>{if(event.persisted) location.reload();});
window.addEventListener('beforeunload',event=>{if(dirty || Object.values(pending).some(Boolean)) {event.preventDefault();event.returnValue='';}});
get('history-tabs') && bindTabs(get('history-tabs'));
function syncQuestionLanguage() {
  const entered=get('question').value,canonical=questions.find(question=>entered===question||entered===hindiText(question));
  if(canonical)get('question').value=localizedText(canonical);
  get('supported-questions').replaceChildren(...questions.map(question=>{const option=node('option');option.value=localizedText(question);return option;}));
}
window.addEventListener('vellum:languagechange',syncQuestionLanguage);syncQuestionLanguage();
for(const [type,label] of Object.entries(names)) {const option=node('option','',label);option.value=type;get('item-type').append(option);}
for(const close of document.querySelectorAll('.dialog-close')) close.append(icon('close'));
for(const id of ['ask-question','optional-check']) get(id).dataset.lane='history';
for(const id of ['request-access','emergency-access']) get(id).dataset.lane='access';
get('add-medicine').prepend(icon('plus'));header();lock();
if(validContext) void poll();else {ended=true;notice('workspace-notice','Select a current patient','Open the encounter from your permitted patient list.','neutral',{label:'Patient list',onClick:()=>location.replace('../patients/')});}

const encounterPrint=node('section','print-only');encounterPrint.id='encounter-print';encounterPrint.translate=false;document.body.append(encounterPrint);
async function reviewedOutput(mode) {
  if(!ready || !hasScope('summary:export') || working.has('history')) return;
  get('more-tools').open=false;const epoch=generation,access=historyEpoch;working.add('history');lock();
  notice('save-feedback','Preparing reviewed output…','Checking current sharing and the exact committed batch.','info');
  try {
    const value=await api.read(`/encounters/${context.encounter_id}/${mode==='download'?'fhir-export':'summary'}`);
    if(epoch!==generation || access!==historyEpoch || !hasScope('summary:export') || document.hidden) return;
    if(mode==='download') {
      const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/fhir+json'})),link=node('a');
      link.href=url;link.download=`vellum-reviewed-${crypto.randomUUID()}.json`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    } else {
      encounterPrint.replaceChildren(node('h1','','Reviewed visit summary'),node('p','patient-name',value.patient_display_name),node('p','',`Reviewed by ${value.review.reviewer_display_name} · ${new Date(value.review.reviewed_at).toLocaleString()}`),node('p','source-copy',value.reviewed_text));
      for(const statement of value.statements) encounterPrint.append(node('p','source-copy',statement.display_text));
      for(const warning of value.warnings) encounterPrint.append(node('p','field-help',warning));localizeUI(encounterPrint);window.print();
    }
    notice('save-feedback',mode==='download'?'Download prepared':'Print summary prepared','The output covers the committed reviewed batch. Official FHIR validation has not been run.','info');
  } catch(error) {if(epoch===generation && !ended) notice('save-feedback','Reviewed output unavailable',errorMessage(error));}
  finally {working.delete('history');lock();}
}
for(const [id,label,mode] of [['print-reviewed','Print reviewed summary','print'],['download-reviewed','Download reviewed record','download']]) {
  const control=node('button','menu-action',label);control.id=id;control.type='button';control.addEventListener('click',()=>reviewedOutput(mode));get('more-tools').querySelector('.tool-menu').append(control);
}
window.addEventListener('afterprint',()=>encounterPrint.replaceChildren());

const interpretationLabel=node('label','optional-interpretation field-help'),interpretation=node('input');interpretation.type='checkbox';interpretation.id='interpret-question';
interpretationLabel.append(interpretation,node('span','','Use optional text interpretation (six topics only)'));get('question-form').append(interpretationLabel);
function showBrief(proposal) {
  const epoch=generation,rev=revision,version=draft.version,region=get('source-content');region.replaceChildren();
  setText(get('source-title'),'Consultation brief proposal');
  region.append(node('p','field-help','Optional generated proposal from the saved note only. Check every statement and source before using it. No clinical items are created automatically.'));
  region.append(node('p','field-help',`${proposal.generation?.provider ?? 'Text adapter'} · ${proposal.generation?.model ?? 'Model recorded by server'} · ${proposal.generation?.generated_at ?? ''}`));
  const proposed=[];
  for(const [key,section] of Object.entries(proposal.sections)) {
    const title=human(key);region.append(node('h3','section-label',title),node('p','source-copy',section.text ?? 'Not supplied in the source note.'));
    if(section.text) proposed.push(`${title}:\n${section.text}`);
    for(const quote of section.note_quotes ?? []) region.append(node('p','field-help',`Source quote: ${quote}`));
  }
  if(!proposed.length) {
    region.append(node('p','field-help','No note text was proposed. Your saved note is unchanged.'));
    dialogs.source.open(get('more-tools').querySelector('summary'));return;
  }
  const apply=textButton('Use proposal as visit note',()=>{
    if(epoch!==generation || rev!==revision || dirty || draft?.version!==version || !ready || committed || pending.write) {notice('save-feedback','Proposal not applied','The note changed. Review the current saved draft before applying a proposal.');return;}
    const text=proposed.join('\n\n');if(text.length+get('assessment').value.length+40>8000) {notice('save-feedback','Proposal too long','Edit the proposal manually to fit the note limit.');return;}
    get('visit-note').value=text;dialogs.source.close();markDirty();
  });region.append(apply);dialogs.source.open(get('more-tools').querySelector('summary'));
}
const briefControl=node('button','menu-action','Consultation brief proposal');briefControl.type='button';briefControl.id='consultation-brief';briefControl.dataset.command='';
briefControl.addEventListener('click',async()=>{
  get('more-tools').open=false;if(!ready || committed || pending.write) return;
  if(!dirty && draft?.ai_proposal && !draft.ai_proposal.include_history && draft.version===draft.ai_proposal.source_version+1) {showBrief(draft.ai_proposal);return;}
  const epoch=generation;if(!(await saveDraft()) || epoch!==generation || !draft || dirty) return;
  const rev=revision,result=await command('brief','/ai/consultation/brief',{draft_id:draft.draft_id,expected_draft_version:draft.version,include_history:false},'Prepare consultation brief');
  if(result && epoch===generation && rev===revision && !dirty && draft?.ai_proposal) showBrief(draft.ai_proposal);
});get('more-tools').querySelector('.tool-menu').append(briefControl);
