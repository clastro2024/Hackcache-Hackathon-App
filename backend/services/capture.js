import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, draftItemSchema, eventSchema, id } from '../schemas.js';
import { canonicalJSON, digest, parseJSON, reviewedEvent, appendReviewedDraft, clinicalSource, termFamilies } from './vault.js';

const simulation='Simulated transcription — predefined text; audio is not processed.';
const normalize=value=>value.normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase();
const aliases={ecosprin_demo:['ecosprin'],metformin_demo:['metformin'],telmisartan_demo:['telmisartan'],
  type2_diabetes_demo:['type 2 diabetes','type-2 diabetes'],penicillin_demo:['penicillin'],latex_demo:['latex'],
  renal_impairment_demo:['renal impairment'],mental_health_demo:['mental-health diagnosis','mental health diagnosis'],
  cholecystectomy_demo:['cholecystectomy'],dyspepsia_demo:['dyspepsia']};
const warningMessages={SIMULATED_INPUT:simulation,MANUAL_ITEMS_REQUIRED:'Manual entry creates no automatic structured items.',
  NO_STRUCTURED_ITEMS:'Enter supported structured items before requesting review.',
  MEDICATION_DETAILS_NOT_RECORDED:'The original source does not record medication details.',
  UNRESOLVED_MEDICATION_NAME:'The original source does not identify the BP medicine.',
  FAMILY_HISTORY_ONLY:'Family history is source context, not the patient’s diagnosis.',
  ALLERGY_STATUS_UNKNOWN:'Unknown allergy wording is not a negative declaration.',
  FOLLOW_UP_SOURCE_ONLY:'Follow-up wording is retained as source text; no appointment is created.',
  ITEM_INCOMPLETE:'Complete the item, source and current target fields before review.',
  UNMAPPED_TERMINOLOGY:'The concept has no mapping in the limited demo vocabulary.',
  POSSIBLE_DUPLICATE:'Separate same-name entities are retained; review possible duplication.'};
const warningSchema=z.strictObject({code:z.enum(Object.keys(warningMessages)),level:z.enum(['INFO','INCOMPLETE']),
  item_index:z.number().int().min(0).max(19).nullable(),message:z.enum(Object.values(warningMessages))});
const storedSchema=z.strictObject({capture_schema_version:z.literal('scribe-draft-v1'),input_mode:z.enum(['MANUAL_TEXT','MOCK_FIXTURE']),
  language:z.enum(['hi','en']),fixture_id:id.nullable(),extractor_version:id,mock_mode_used:z.boolean(),simulation_label:z.string().nullable(),
  original_text:z.string(),text:z.string(),items:z.array(draftItemSchema).max(20),warnings:z.array(warningSchema).max(100),edited:z.boolean()});
export function storedCapture(row) {
  try {
    const value=storedSchema.parse(parseJSON(row.capture_json));
    if(canonicalJSON(value)!==row.capture_json || (row.reviewed_payload_hash && digest(row.capture_json)!==row.reviewed_payload_hash)) throw new Error();
    return value;
  } catch {throw new ApiError('CLINICAL_INTEGRITY_INVALID');}
}

export function createCapture(store,auth,operations,{now,settings,mock,hooks={}}) {
  let inFlight=0;
  const draft=id=>store.db.prepare('SELECT * FROM clinical_drafts WHERE draft_id=?').get(id);
  const forEncounter=id=>store.db.prepare('SELECT * FROM clinical_drafts WHERE encounter_id=?').get(id);
  function assigned(ref,encounterId) {
    const ctx=auth.encounter(ref,encounterId);
    if(ctx.actor.role!=='CLINICIAN') throw new ApiError('RESOURCE_UNAVAILABLE');
    if(!ctx.actor.permissions.includes('clinical:write')) throw new ApiError('SCOPE_DENIED');return ctx;
  }
  function open(ctx) {
    if(ctx.encounter.closed_at!==null || ctx.encounter.checked_in_at===null) throw new ApiError('INVALID_TRANSITION');
  }
  function version(row,expected) {
    if(row?.version!==expected) throw new ApiError('DRAFT_VERSION_CONFLICT');
    if(['COMMITTED','DISCARDED'].includes(row?.state)) throw new ApiError('INVALID_TRANSITION');
  }
  function sourceAuthority(ref,ctx,items) {
    if(!items.some(item=>item.change_kind!=='INITIAL')) return;
    try {auth.encounter(ref,ctx.encounter.encounter_id,{scope:'triage:read'});} catch {throw new ApiError('RESOURCE_UNAVAILABLE');}
  }
  function targets(ref,ctx,items,{allowIncomplete=false}={}) {
    sourceAuthority(ref,ctx,items.filter(item=>item.supersedes_event_id));
    const used=new Set();
    for(const item of items) {
      if(item.entity_id && used.has(item.entity_id)) throw new ApiError('STATE_VERSION_CONFLICT');
      if(item.entity_id) used.add(item.entity_id);
      if(item.change_kind==='INITIAL' && store.db.prepare("SELECT 1 FROM clinical_events WHERE json_extract(event_json,'$.entity_id')=? LIMIT 1").get(item.entity_id)) throw new ApiError('RESOURCE_UNAVAILABLE');
    }
    if(!items.some(item=>item.supersedes_event_id)) return;
    const source=clinicalSource(store,ctx.encounter.patient_id);
    const byId=new Map(source.rows.map(row=>[row.event.event_id,row.event]));
    const tips=new Map(source.rows.map(row=>[row.event.entity_id,row.event]));
    for(const item of items) {
      if(item.change_kind==='INITIAL') continue;
      if(allowIncomplete && !item.supersedes_event_id) continue;
      const prior=byId.get(item.supersedes_event_id);
      if(!prior || prior.entity_id!==item.entity_id || (item.event_type!=='RECORD_RETRACTED' && prior.event_type!==item.event_type)) throw new ApiError('RESOURCE_UNAVAILABLE');
      if(tips.get(prior.entity_id).event_id!==prior.event_id || prior.event_type==='RECORD_RETRACTED') throw new ApiError('STATE_VERSION_CONFLICT');
    }
  }
  function bind(items,previous,ctx) {
    const existing=new Set(previous?.items.filter(item=>item.change_kind==='INITIAL').map(item=>item.entity_id));
    return items.map(value=>{
      const item=structuredClone(draftItemSchema.parse(value));
      if(item.change_kind==='INITIAL') {
        if(item.entity_id && !existing.has(item.entity_id)) throw new ApiError('RESOURCE_UNAVAILABLE');
        item.entity_id ??= `entity_${randomUUID()}`;
      }
      if(item.event_type==='NEGATIVE_FINDING_RECORDED') {
        if(item.source.kind==='CLINICIAN_ASSESSMENT') item.payload.declared_by=ctx.actor.account_id;
        if(item.source.kind==='PATIENT_REPORT') item.payload.declared_by=ctx.encounter.patient_id;
      }
      const concept=item.payload.concept;
      if(concept?.coding) throw new ApiError('VALIDATION_ERROR');
      if(concept?.term_key && (!concept.text || !aliases[concept.term_key]?.includes(normalize(concept.text)) ||
        !termFamilies[item.event_type]?.includes(concept.term_key))) throw new ApiError('VALIDATION_ERROR');
      if(item.source.reference && !id.safeParse(item.source.reference).success) throw new ApiError('VALIDATION_ERROR');
      return item;
    });
  }
  function validation(capture,ctx) {
    const issues=[];
    if(!capture.items.length) issues.push({path:'items',code:'REQUIRED'});
    const facilityId=store.db.prepare('SELECT facility_id FROM schema_meta WHERE singleton=1').get().facility_id;
    capture.items.forEach((item,index)=>{
      const result=eventSchema.safeParse(reviewedEvent(item,capture,{encounter:ctx.encounter,actorId:ctx.actor.account_id,
        facilityId,reviewedAt:ctx.now,time:ctx.now,sequence:index+1,eventId:'evt_validation'}));
      if(!result.success) issues.push({path:`items.${index}`,code:'INCOMPLETE'});
      if(item.source.quote && !capture.text.includes(item.source.quote)) issues.push({path:`items.${index}.source.quote`,code:'SOURCE_MISMATCH'});
      if(item.source.kind==='PATIENT_REPORT' && (item.payload.verification_status==='CONFIRMED' ||
        item.event_type==='PROCEDURE_RECORDED' && item.payload.status==='COMPLETED')) issues.push({path:`items.${index}.payload`,code:'SOURCE_MISMATCH'});
      if(item.event_type==='NEGATIVE_FINDING_RECORDED' && item.source.kind==='DOCUMENT_REFERENCE' &&
        (!item.source.original_author || item.payload.declared_by!==item.source.original_author)) issues.push({path:`items.${index}.payload.declared_by`,code:'SOURCE_MISMATCH'});
    });
    return issues;
  }
  function warnings(capture,ctx) {
    const result=[];const add=(code,level='INFO',item_index=null)=>result.push({code,level,item_index,message:warningMessages[code]});
    if(capture.mock_mode_used) {
      add('SIMULATED_INPUT');
      const original=mock.available?mock.registry.fixtures.find(f=>f.fixture_id===capture.fixture_id):null;
      for(const code of original?.warning_codes ?? []) if(!['SIMULATED_INPUT','UPDATE_TARGET_REQUIRED','MEDICATION_DETAILS_MISSING','STOP_REASON_MISSING'].includes(code) && warningMessages[code]) add(code);
    }
    if(!capture.items.length) add(capture.input_mode==='MANUAL_TEXT'?'MANUAL_ITEMS_REQUIRED':'NO_STRUCTURED_ITEMS','INCOMPLETE');
    const invalid=new Set(validation(capture,ctx).map(issue=>Number(/^items\.(\d+)/u.exec(issue.path)?.[1])).filter(Number.isInteger));
    const names=new Set();
    capture.items.forEach((item,index)=>{
      if(invalid.has(index)) add('ITEM_INCOMPLETE','INCOMPLETE',index);
      if(item.payload.concept && !item.payload.concept.term_key) add('UNMAPPED_TERMINOLOGY','INFO',index);
      const name=item.payload.concept?.text?`${item.event_type}:${normalize(item.payload.concept.text)}`:null;
      if(name && names.has(name)) add('POSSIBLE_DUPLICATE','INFO',index);if(name) names.add(name);
    });return result;
  }
  function encoded(capture,ctx) {
    capture.warnings=warnings(capture,ctx);
    const value=canonicalJSON(storedSchema.parse(capture));
    if(Buffer.byteLength(value)>131072) throw new ApiError('DRAFT_TOO_LARGE');return value;
  }
  function snapshot(row,ctx) {
    if(!row) return null;
    const capture=storedCapture(row);
    return {...capture,draft_id:row.draft_id,encounter_id:row.encounter_id,state:row.state,version:row.version,
      reviewed_payload_hash:row.reviewed_payload_hash,reviewed_by:row.reviewed_by,
      reviewed_at:row.reviewed_at===null?null:new Date(row.reviewed_at).toISOString(),
      committed_event_ids:row.committed_event_ids_json?parseJSON(row.committed_event_ids_json):null,
      can_request_review:row.state==='DRAFT' && validation(capture,ctx).length===0};
  }
  async function readDraft(ref,encounterId,outcome) {
    auth.admitSensitive(ref);
    const result=await operations.readProtected(ref,{maxBytes:196608,authorize:()=>{
      const ctx=assigned(ref,encounterId);open(ctx);
      const row=forEncounter(encounterId);if(row) sourceAuthority(ref,ctx,storedCapture(row).items.filter(item=>item.supersedes_event_id));
      return ctx;
    },capture:ctx=>{
      const row=forEncounter(encounterId);
      const available=Boolean(row && (!outcome || row.draft_id===outcome.draft_id && row.version===outcome.version));
      return {source:{draft:available?snapshot(row,ctx):null,current_draft_version:row?.version ?? null,snapshot_available:available},version:row?.version ?? null};
    },compute:source=>({...source,...(outcome?{...outcome,outcome:outcome.status,draft_version:outcome.version,draft_state:outcome.draft_state}:{})}),
    recheck:(_ctx,selected)=>{if((forEncounter(encounterId)?.version ?? null)!==selected.version) throw new ApiError('DRAFT_VERSION_CONFLICT');},
    audit:ctx=>({patient_id:ctx.encounter.patient_id,encounter_id:encounterId,operation:'DRAFT_READ',result:'RELEASED',details:{}})});
    return result;
  }
  async function command(ref,intent,action,selectedId) {
    const body=intent.body;
    const encounterId=action==='capture'?body.encounter_id:draft(selectedId ?? body.draft_id)?.encounter_id;
    if(!encounterId) {auth.authenticate(ref);throw new ApiError('RESOURCE_UNAVAILABLE');}
    const result=await operations.executeCommand(ref,intent,()=>assigned(ref,encounterId),ctx=>{
      open(ctx);
      const row=forEncounter(encounterId);
      let capture;
      if(action==='capture') {
        if(row) version(row,body.expected_draft_version);
        else if(body.expected_draft_version!==undefined) throw new ApiError('DRAFT_VERSION_CONFLICT');
        let fixture;
        if(body.input_mode==='MOCK_FIXTURE') {
          if(!settings.mockAsr.valid || !settings.mockAsr.enabled || !mock.available) throw new ApiError('ASR_MODE_UNAVAILABLE');
          fixture=mock.registry.fixtures.find(f=>f.fixture_id===body.fixture_id);
          if(!fixture) throw new ApiError('UNKNOWN_FIXTURE');
          if(fixture.language!==body.language) throw new ApiError('FIXTURE_LANGUAGE_MISMATCH');
        }
        capture={capture_schema_version:'scribe-draft-v1',input_mode:body.input_mode,language:body.language,
          fixture_id:fixture?.fixture_id ?? null,extractor_version:fixture?mock.registry.extractor_version:'manual-entry-v1',
          mock_mode_used:Boolean(fixture),simulation_label:fixture?simulation:null,original_text:fixture?.text ?? body.text,
          text:fixture?.text ?? body.text,items:[],warnings:[],edited:false};
        capture.items=bind((fixture?.item_templates ?? []).map(item=>({event_type:item.event_type,change_kind:item.change_kind,payload:item.payload,
          entity_id:null,change_reason:null,supersedes_event_id:null,occurred_on:null,occurrence_text:null,
          source:{kind:item.source_kind,reference:fixture.fixture_id,authored_on:null,original_author:null,quote:item.quote}})),null,ctx);
        const json=encoded(capture,ctx);const draftId=row?.draft_id ?? `draft_${randomUUID()}`;
        if(row) store.db.prepare(`UPDATE clinical_drafts SET state='DRAFT',version=version+1,capture_json=?,reviewed_payload_hash=NULL,
          reviewed_by=NULL,reviewed_at=NULL,updated_at=? WHERE draft_id=?`).run(json,ctx.now,draftId);
        else store.db.prepare(`INSERT INTO clinical_drafts VALUES(?,?,'DRAFT',1,?,NULL,NULL,NULL,NULL,?)`).run(draftId,encounterId,json,ctx.now);
        return {status:'DRAFT_CAPTURED',changed:true,draft_id:draftId,encounter_id:encounterId,version:(row?.version ?? 0)+1,draft_state:'DRAFT'};
      }
      if(!row || row.draft_id!==(selectedId ?? body.draft_id)) throw new ApiError('RESOURCE_UNAVAILABLE');
      version(row,body.expected_draft_version);capture=storedCapture(row);
      if(action==='save') {
        const items=bind(body.items,capture,ctx);targets(ref,ctx,items,{allowIncomplete:true});
        capture={...capture,text:body.text,items,edited:true};const json=encoded(capture,ctx);
        store.db.prepare(`UPDATE clinical_drafts SET state='DRAFT',version=version+1,capture_json=?,reviewed_payload_hash=NULL,
          reviewed_by=NULL,reviewed_at=NULL,updated_at=? WHERE draft_id=?`).run(json,ctx.now,row.draft_id);
        return {status:'DRAFT_SAVED',changed:true,draft_id:row.draft_id,encounter_id:encounterId,version:row.version+1,draft_state:'DRAFT'};
      }
      const issues=validation(capture,ctx);
      if(issues.length) throw new ApiError('REVIEW_VALIDATION_FAILED',{fields:issues.slice(0,8)});
      targets(ref,ctx,capture.items);
      if(action==='review') {
        if(row.state!=='DRAFT') throw new ApiError('INVALID_TRANSITION');
        const hash=digest(row.capture_json);
        store.db.prepare(`UPDATE clinical_drafts SET state='REVIEWED',version=version+1,reviewed_payload_hash=?,reviewed_by=?,reviewed_at=?,updated_at=? WHERE draft_id=?`)
          .run(hash,ctx.actor.account_id,ctx.now,ctx.now,row.draft_id);
        return {status:'DRAFT_REVIEWED',changed:true,draft_id:row.draft_id,encounter_id:encounterId,version:row.version+1,
          draft_state:'REVIEWED',reviewed_payload_hash:hash};
      }
      if(action!=='commit' || row.state!=='REVIEWED' || body.reviewed_payload_hash!==row.reviewed_payload_hash || row.reviewed_by!==ctx.actor.account_id) throw new ApiError('INVALID_TRANSITION');
      const events=appendReviewedDraft(store,row.draft_id,ctx.actor.account_id,ctx.now);
      store.db.prepare(`UPDATE clinical_drafts SET state='COMMITTED',version=version+1,committed_event_ids_json=?,updated_at=? WHERE draft_id=?`)
        .run(canonicalJSON(events.event_ids),ctx.now,row.draft_id);
      return {status:'DRAFT_COMMITTED',changed:true,draft_id:row.draft_id,encounter_id:encounterId,patient_id:ctx.encounter.patient_id,
        version:row.version+1,draft_state:'COMMITTED',...events};
    },{audit:(ctx,result)=>({patient_id:ctx.encounter.patient_id,encounter_id:encounterId,operation:`SCRIBE_${action.toUpperCase()}`,result:'SUCCESS',
      details:{draft_id:result.draft_id,version:result.version,...(result.event_ids?{event_ids:result.event_ids}:{}),
        ...(action==='capture'?{method:body.input_mode==='MANUAL_TEXT'?'MANUAL':'MOCK_ASR',fixture_id:body.fixture_id ?? null}:{}),changed:true}})});
    if(action==='commit') {
      try {store.runUnit(false,()=>assigned(ref,encounterId));} catch(error) {error.commit_state='UNKNOWN';throw error;}
      return {safe:true,body:{...result,state:'COMMITTED',draft_version:result.version}};
    }
    try {
      const protectedDraft=await readDraft(ref,encounterId,result);
      return {release(){try {return protectedDraft.release();} catch(error) {error.commit_state='UNKNOWN';throw error;}}};
    } catch(error) {error.commit_state='UNKNOWN';throw error;}
  }
  return {command,readDraft,
    // Reserve before body parsing; no waiting queue. The route releases on finish/close/failure.
    admit(ref,csrf){const ctx=auth.authenticate(ref);auth.csrf(ctx,csrf);
      if(ctx.actor.role!=='CLINICIAN' || !ctx.actor.permissions.includes('clinical:write')) throw new ApiError('SCOPE_DENIED');
      if(inFlight>=10) throw new ApiError('INGESTION_BUSY',{retryAfter:1});inFlight+=1;
      let ended=false;return ()=>{if(!ended){ended=true;inFlight-=1;}};
    },get inFlight(){return inFlight;},
    async beforeCapture(){if(hooks.beforeCapture) await hooks.beforeCapture();},
  };
}
