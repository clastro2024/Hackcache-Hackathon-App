import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, id, xmlText, timestamp } from '../schemas.js';
import { canonicalJSON, digest, parseJSON, clinicalSource, reviewedEvent } from './vault.js';
import { storedCapture } from './capture.js';

export const OUTPUT_LIMIT=1048576;
export function boundedOutput(value) {
  const buffer=Buffer.from(JSON.stringify(value),'utf8');
  if(buffer.length>OUTPUT_LIMIT) throw new ApiError('EXPORT_TOO_LARGE');return buffer;
}
const label=value=>value ?? 'Not recorded';
const kind=event=>event.event_type==='MEDICATION_RECORDED' && event.payload.statement_kind==='PRESCRIBED'?'PRESCRIPTION':
  event.event_type==='CONDITION_RECORDED'?'CONDITION':'OTHER';
export function statementText(event) {
  const p=event.payload;
  const context=`Event ${event.event_id}, sequence ${event.sequence}. Source: ${event.source.kind}; author: ${label(event.source.original_author)}; source date: ${label(event.source.authored_on)}; occurrence: ${label(event.occurred_on ?? event.occurrence_text)}.`;
  let finding;
  switch(event.event_type) {
    case 'MEDICATION_RECORDED': finding=`${p.concept.text}; ${p.statement_kind}; status ${p.status}. Dose: ${label(p.dose_text)}; route: ${label(p.route_text)}; frequency: ${label(p.frequency_text)}; duration: ${label(p.duration_text)}; reason: ${label(p.reason)}.`;break;
    case 'CONDITION_RECORDED': finding=`${p.concept.text}; clinical status ${p.clinical_status}; verification ${p.verification_status}.`;break;
    case 'ALLERGY_RECORDED': finding=`Allergy statement: ${p.concept.text}; clinical status ${p.clinical_status}; verification ${p.verification_status}; reaction ${label(p.reaction_text)}; severity ${p.reaction_severity}.`;break;
    case 'PROCEDURE_RECORDED': finding=`Procedure statement: ${p.concept.text}; ${p.status}; note: ${label(p.note)}.`;break;
    case 'NEGATIVE_FINDING_RECORDED': finding=`Dated negative declaration only for ${p.scope.topic_key}, ${p.scope.timeframe}. Declared by ${p.declared_by} on ${p.declared_on}. Basis: ${p.clinical_basis}. Scope: ${p.scope_text}. This is not current absence or safety.`;break;
    case 'RECORD_RETRACTED': finding=`Withdrawal of evidence ${event.supersedes_event_id}: ${p.reason}. This is not a negative clinical finding.`;break;
    default: throw new ApiError('SUMMARY_SOURCE_INVALID');
  }
  return `${finding}\n${context}`;
}
const limits=Object.freeze([
  'Fictional data. This summary covers only one committed reviewed encounter batch, not complete patient history or a safety assessment.',
  'Local terminology keys are not verified clinical codes; unmapped concepts remain source text.',
  'Local R4 mapping supports prescriptions and conditions; other statements are retained in narrative and provenance.',
  'Official FHIR validation NOT_RUN. No ABDM profile, signature, identity verification or live exchange is asserted.',
]);
export function buildSummary(source) {
  const {capture,draft,encounter,patient,reviewer,room,dataset,rows,generation_id,generated_at}=source;
  const statements=rows.map(row=>({...row,render_kind:kind(row.event),display_text:statementText(row.event)}));
  const warnings=[...new Set([...capture.warnings.filter(w=>w.level==='INFO').map(w=>w.message),...limits])];
  const sections=[];
  function section(key,title,selected,empty) {sections.push({key,title,text:selected.length?selected.map(row=>row.display_text).join('\n\n'):empty,event_ids:selected.map(row=>row.event.event_id)});}
  const status=encounter.closed_at===null?'OPEN':'CLOSED';
  section('CONTEXT','Context and review',[],`Fictional patient ${patient.display_name} (${patient.patient_id}); encounter ${encounter.encounter_id}, ${status}; closure reason ${label(encounter.closure_reason)}. Facility ${dataset.facility_id}; room ${room.label}. Reviewed by ${reviewer.display_name} (${reviewer.account_id}) at ${new Date(draft.reviewed_at).toISOString()}. Generated ${generated_at}. Dataset ${dataset.dataset_id}; patient sequence ${source.as_of_sequence}; draft ${draft.draft_id} version ${draft.version}; review hash ${draft.reviewed_payload_hash}; mapping local-r4-v1.`);
  section('PRESCRIPTIONS','Prescriptions',statements.filter(row=>row.render_kind==='PRESCRIPTION'),'No prescription item in this committed encounter batch.');
  section('CONDITIONS','Conditions',statements.filter(row=>row.render_kind==='CONDITION'),'No condition item in this committed encounter batch.');
  section('OTHER_STATEMENTS','Other clinical statements',statements.filter(row=>row.render_kind==='OTHER'),'No other structured statement in this committed encounter batch.');
  sections.push({key:'NARRATIVE',title:'Reviewed narrative and advice',text:capture.text,event_ids:rows.map(row=>row.event.event_id)});
  sections.push({key:'PROVENANCE',title:'Provenance and limits',event_ids:rows.map(row=>row.event.event_id),text:rows.map(({event,previous_hash,event_hash})=>
    `Event ${event.event_id}; sequence ${event.sequence}; entity ${event.entity_id}; predecessor ${label(event.supersedes_event_id)}; change ${event.change_kind}; reason ${label(event.change_reason)}.\nSource ${event.source.kind}; reference ${label(event.source.reference)}; author ${label(event.source.original_author)}; authored ${label(event.source.authored_on)}; quote ${label(event.source.quote)}.\nOccurrence ${label(event.occurred_on)}; original occurrence wording ${label(event.occurrence_text)}; recorded ${event.recorded_at} by ${event.recorded_by}; review ${event.review.status} by ${event.review.reviewed_by} at ${event.review.reviewed_at}.\nCapture ${event.capture.method}; fixture ${label(event.capture.fixture_id)}; extractor ${label(event.capture.extractor_version)}; confidence ${label(event.capture.confidence)}; synthetic true. Previous hash ${previous_hash}; event hash ${event_hash}.`)
    .join('\n\n')+`\n\n${warnings.join('\n')}`});
  return {summary_schema_version:'reviewed-summary-v1',mapping_version:'local-r4-v1',generation_id,generated_at,
    dataset_id:dataset.dataset_id,patient_id:patient.patient_id,patient_display_name:patient.display_name,
    encounter_id:encounter.encounter_id,encounter_status:status,facility_label:dataset.facility_id,room_label:room.label,
    as_of_sequence:source.as_of_sequence,committed_event_ids:rows.map(row=>row.event.event_id),draft_id:draft.draft_id,draft_version:draft.version,
    review:{reviewed_by:draft.reviewed_by,reviewer_display_name:reviewer.display_name,reviewed_at:new Date(draft.reviewed_at).toISOString(),reviewed_payload_hash:draft.reviewed_payload_hash},
    synthetic:true,history_scope:'COMMITTED_ENCOUNTER_BATCH',fhir_validation:'NOT_RUN',
    capture:Object.fromEntries(['input_mode','language','fixture_id','extractor_version','mock_mode_used','simulation_label'].map(key=>[key,capture[key]])),
    reviewed_text:capture.text,sections,statements,warnings};
}

const escape=value=>value.replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
const narrative=text=>({status:'additional',div:`<div xmlns="http://www.w3.org/1999/xhtml"><p>${escape(text).replace(/\r\n|\r|\n/gu,'<br/>')}</p></div>`});
const identifier=(namespace,value)=>[{system:`urn:vaultmed:demo:${namespace}`,value}];
const clinicalCode=(system,code)=>({coding:[{system:`http://terminology.hl7.org/CodeSystem/${system}`,code}]});
const statusMap={ACTIVE:'active',COMPLETED:'completed',DISCONTINUED:'stopped',UNKNOWN:'unknown'};
export function buildFHIR(summary,source) {
  const entries=[];
  function add(resourceType,fields) {
    const resource={resourceType,id:randomUUID(),...fields};
    const entry={fullUrl:`urn:uuid:${resource.id}`,resource};entries.push(entry);return {reference:entry.fullUrl};
  }
  const compositionFields={status:'final',type:{text:'Reviewed OPD encounter summary'},date:summary.review.reviewed_at,
    title:'Fictional reviewed OPD encounter summary',text:narrative(summary.sections.map(section=>`${section.title}\n${section.text}`).join('\n\n'))};
  add('Composition',compositionFields);const composition=entries[0].resource;
  const patient=add('Patient',{identifier:identifier('patients',summary.patient_id),name:[{text:summary.patient_display_name}],
    text:narrative(`Fictional patient ${summary.patient_display_name}; local identifier ${summary.patient_id}.`)});
  const references=new Map();
  for(const row of summary.statements.filter(row=>row.render_kind==='PRESCRIPTION')) {
    const {event}=row,p=event.payload;
    references.set(event.event_id,add('MedicationRequest',{identifier:identifier('clinical-events',event.event_id),status:statusMap[p.status],intent:'order',
      medicationCodeableConcept:{text:p.concept.text},subject:patient,dosageInstruction:[{text:`Dose: ${label(p.dose_text)}; route: ${label(p.route_text)}; frequency: ${label(p.frequency_text)}; duration: ${label(p.duration_text)}.`}],
      ...(p.reason?{statusReason:{text:p.reason}}:{}),...(event.source.kind!=='CLINICIAN_ASSESSMENT'?{reportedBoolean:true}:{}),
      text:narrative(`Fictional patient ${summary.patient_display_name} (${summary.patient_id}).\n${row.display_text}\nReviewed by ${summary.review.reviewer_display_name} at ${summary.review.reviewed_at}; this does not establish original prescriber identity or current ingestion.`)}));
  }
  for(const row of summary.statements.filter(row=>row.render_kind==='CONDITION')) {
    const {event}=row,p=event.payload;
    references.set(event.event_id,add('Condition',{identifier:identifier('clinical-events',event.event_id),code:{text:p.concept.text},subject:patient,
      ...(p.clinical_status!=='UNKNOWN'?{clinicalStatus:clinicalCode('condition-clinical',p.clinical_status.toLowerCase())}:{}),
      verificationStatus:clinicalCode('condition-ver-status',p.verification_status.toLowerCase()),recordedDate:event.recorded_at,
      text:narrative(`Fictional patient ${summary.patient_display_name} (${summary.patient_id}).\n${row.display_text}\nReview ${summary.review.reviewed_at}; source or recording date is not an onset date.`)}));
  }
  const practitioner=add('Practitioner',{identifier:identifier('accounts',summary.review.reviewed_by),name:[{text:summary.review.reviewer_display_name}],
    text:narrative(`Seeded fictional demo reviewer ${summary.review.reviewer_display_name} (${summary.review.reviewed_by}); no live identity or registration verification.`)});
  const encounter=add('Encounter',{identifier:identifier('encounters',summary.encounter_id),status:source.encounter.closed_at===null?'in-progress':'finished',
    class:{system:'http://terminology.hl7.org/CodeSystem/v3-ActCode',code:'AMB',display:'ambulatory'},subject:patient,
    period:{start:new Date(source.encounter.checked_in_at).toISOString(),...(source.encounter.closed_at!==null?{end:new Date(source.encounter.closed_at).toISOString()}:{})},
    text:narrative(`Fictional encounter ${summary.encounter_id}, ${summary.encounter_status}, for ${summary.patient_display_name} (${summary.patient_id}); facility ${summary.facility_label}; room ${summary.room_label}; check-in ${new Date(source.encounter.checked_in_at).toISOString()}; closure ${source.encounter.closed_at===null?'Not recorded':new Date(source.encounter.closed_at).toISOString()}.`)});
  Object.assign(composition,{subject:patient,encounter,author:[practitioner],section:summary.sections.map(section=>{
    const linked=section.key==='PRESCRIPTIONS'||section.key==='CONDITIONS'?section.event_ids.map(id=>references.get(id)).filter(Boolean):[];
    return {title:section.title,text:narrative(section.text),...(linked.length?{entry:linked}:{})};
  })});
  return {resourceType:'Bundle',type:'document',identifier:{system:'urn:vaultmed:demo:documents',value:summary.generation_id},
    timestamp:summary.generated_at,meta:{lastUpdated:summary.generated_at},entry:entries};
}

// Strict application preflight for this fixed local mapping; not an official FHIR validator.
const value=z.string().min(1).refine(xmlText);
const uuid=z.uuid();
const url=z.string().regex(/^urn:uuid:[a-f0-9-]{36}$/u);
const reference=z.strictObject({reference:url});
const cc=z.strictObject({text:value});
const narrativeSchema=z.strictObject({status:z.literal('additional'),div:value.refine(v=>
  /^<div xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"><p>(?:[^<&]|&(?:amp|lt|gt|quot|apos);|<br\/>)+<\/p><\/div>$/u.test(v))});
const identified=namespace=>z.array(z.strictObject({system:z.literal(`urn:vaultmed:demo:${namespace}`),value:id})).length(1);
const code=(system,values)=>z.strictObject({coding:z.array(z.strictObject({system:z.literal(`http://terminology.hl7.org/CodeSystem/${system}`),code:z.enum(values)})).length(1)});
const base={id:uuid,text:narrativeSchema};
const resourceSchema=z.discriminatedUnion('resourceType',[
  z.strictObject({...base,resourceType:z.literal('Composition'),status:z.literal('final'),type:cc,date:timestamp,title:value,
    subject:reference,encounter:reference,author:z.array(reference).length(1),section:z.array(z.strictObject({title:value,text:narrativeSchema,entry:z.array(reference).min(1).max(20).optional()})).length(6)}),
  z.strictObject({...base,resourceType:z.literal('Patient'),identifier:identified('patients'),name:z.array(z.strictObject({text:value})).length(1)}),
  z.strictObject({...base,resourceType:z.literal('Practitioner'),identifier:identified('accounts'),name:z.array(z.strictObject({text:value})).length(1)}),
  z.strictObject({...base,resourceType:z.literal('Encounter'),identifier:identified('encounters'),status:z.enum(['in-progress','finished']),
    class:z.strictObject({system:z.literal('http://terminology.hl7.org/CodeSystem/v3-ActCode'),code:z.literal('AMB'),display:z.literal('ambulatory')}),subject:reference,
    period:z.strictObject({start:timestamp,end:timestamp.optional()})}),
  z.strictObject({...base,resourceType:z.literal('MedicationRequest'),identifier:identified('clinical-events'),status:z.enum(['active','completed','stopped','unknown']),intent:z.literal('order'),
    medicationCodeableConcept:cc,subject:reference,dosageInstruction:z.array(z.strictObject({text:value})).length(1),statusReason:cc.optional(),reportedBoolean:z.literal(true).optional()}),
  z.strictObject({...base,resourceType:z.literal('Condition'),identifier:identified('clinical-events'),code:cc,subject:reference,
    clinicalStatus:code('condition-clinical',['active','resolved']).optional(),verificationStatus:code('condition-ver-status',['confirmed','unconfirmed']),recordedDate:timestamp}),
]);
const bundleSchema=z.strictObject({resourceType:z.literal('Bundle'),type:z.literal('document'),
  identifier:z.strictObject({system:z.literal('urn:vaultmed:demo:documents'),value:uuid}),timestamp,meta:z.strictObject({lastUpdated:timestamp}),
  entry:z.array(z.strictObject({fullUrl:url,resource:resourceSchema})).min(4).max(24)});
export function preflightFHIR(bundle,summary,source) {
  try {
    bundleSchema.parse(bundle);
    const entries=bundle.entry,ids=new Set(entries.map(e=>e.resource.id)),urls=new Set(entries.map(e=>e.fullUrl));
    if(ids.size!==entries.length || urls.size!==entries.length || entries.some(e=>e.fullUrl!==`urn:uuid:${e.resource.id}`) ||
      entries[0].resource.resourceType!=='Composition' || entries[1].resource.resourceType!=='Patient' || bundle.meta.lastUpdated!==bundle.timestamp) throw new Error();
    const visit=value=>{
      if(!value || typeof value!=='object') return;
      if('reference' in value && !urls.has(value.reference)) throw new Error();
      for(const child of Object.values(value)) visit(child);
    };visit(bundle);
    // Check exact mapping/coverage/references against a fresh pure build of the same reviewed source.
    const expected=buildFHIR(summary,source);
    const normalize=value=>{
      const rewrite=new Map(value.entry.map((e,index)=>[e.fullUrl,`resource-${index}`]));
      const walk=(item,key)=>{
        if(key==='id') return 'resource-id';
        if(typeof item==='string' && rewrite.has(item)) return rewrite.get(item);
        if(Array.isArray(item)) return item.map(child=>walk(child));
        if(item && typeof item==='object') return Object.fromEntries(Object.entries(item).map(([k,v])=>[k,walk(v,k)]));return item;
      };return canonicalJSON(walk(value));
    };
    if(normalize(bundle)!==normalize(expected)) throw new Error();
    return true;
  } catch {throw new ApiError('FHIR_BUILD_FAILED');}
}

export function createOutput(store,auth,operations,{now,hooks={}}) {
  let inFlight=false;
  function authorize(ref,encounterId) {
    const ctx=auth.authenticate(ref),encounter=store.db.prepare('SELECT * FROM encounters WHERE encounter_id=?').get(encounterId);
    if(!encounter) throw new ApiError('RESOURCE_UNAVAILABLE');
    if(ctx.actor.role==='PATIENT') {auth.ownPatient(ref,encounter.patient_id);return {...ctx,encounter};}
    const assigned=auth.encounter(ref,encounterId);
    if(assigned.actor.role!=='CLINICIAN') throw new ApiError('RESOURCE_UNAVAILABLE');
    const permitted=auth.encounter(ref,encounterId,{scope:'summary:export'});
    if(permitted.grant.mode!=='PATIENT_APPROVED') throw new ApiError('SCOPE_DENIED');return permitted;
  }
  function capture(ctx) {
    const {encounter}=ctx,draft=store.db.prepare('SELECT * FROM clinical_drafts WHERE encounter_id=?').get(encounter.encounter_id);
    if(!draft || draft.state!=='COMMITTED') throw new ApiError('SUMMARY_NOT_COMMITTED');
    let result;
    try {
      const saved=storedCapture(draft),eventIds=z.array(id).min(1).max(20).parse(parseJSON(draft.committed_event_ids_json,8192));
      if(new Set(eventIds).size!==eventIds.length || eventIds.length!==saved.items.length || !draft.reviewed_by || draft.reviewed_by!==encounter.clinician_id ||
        draft.reviewed_at===null || draft.reviewed_at>draft.updated_at || !draft.reviewed_payload_hash) throw new Error();
      const source=clinicalSource(store,encounter.patient_id),events=new Map(source.rows.map(row=>[row.event.event_id,row]));
      const rows=eventIds.map(id=>events.get(id));
      if(rows.some(row=>!row) || source.rows.filter(row=>row.event.encounter_id===encounter.encounter_id).length!==rows.length) throw new Error();
      const dataset=store.db.prepare('SELECT dataset_id,facility_id FROM schema_meta WHERE singleton=1').get();
      const reviewer=store.db.prepare('SELECT account_id,username,role FROM accounts WHERE account_id=?').get(draft.reviewed_by);
      if(reviewer) {reviewer.display_name=`Fictional clinician (${reviewer.username})`;delete reviewer.username;}
      const patient=store.db.prepare('SELECT patient_id,display_name FROM patients WHERE patient_id=?').get(encounter.patient_id);
      const room=store.db.prepare('SELECT room_id,label FROM rooms WHERE room_id=?').get(encounter.room_id);
      if(!reviewer || reviewer.role!=='CLINICIAN' || !patient || !room || encounter.checked_in_at===null) throw new Error();
      rows.forEach((row,index)=>{
        const event=row.event;
        if(index && event.sequence!==rows[index-1].event.sequence+1 || event.capture.method==='FIXTURE_SEED' ||
          canonicalJSON(event)!==canonicalJSON(reviewedEvent(saved.items[index],saved,{encounter,actorId:draft.reviewed_by,
            facilityId:dataset.facility_id,reviewedAt:draft.reviewed_at,time:Date.parse(event.recorded_at),sequence:event.sequence,eventId:event.event_id}))) throw new Error();
      });
      const tips=new Map(source.rows.map(row=>[row.event.entity_id,row.event.event_id]));
      result={draft,capture:saved,encounter,patient,reviewer,room,dataset,rows,as_of_sequence:source.as_of_sequence,head_hash:source.head_hash,
        outdated:rows.some(row=>tips.get(row.event.entity_id)!==row.event.event_id)};
      result.context_hash=digest(canonicalJSON({draft,encounter,patient,reviewer,room,dataset,rows}));
    } catch {throw new ApiError('SUMMARY_SOURCE_INVALID');}
    if(result.outdated) throw new ApiError('SUMMARY_OUTDATED');return result;
  }
  async function generate(ref,encounterId,format,metadata={}) {
    auth.admitSensitive(ref);store.runUnit(false,()=>authorize(ref,encounterId));
    if(inFlight) throw new ApiError('EXPORT_BUSY',{retryAfter:1});inFlight=true;
    try {
      let generationId;
      const result=await operations.readProtected(ref,{maxBytes:OUTPUT_LIMIT,authorize:()=>authorize(ref,encounterId),
        capture:ctx=>{
          const source=capture(ctx);source.generation_id=randomUUID();source.generated_at=new Date(now()).toISOString();generationId=source.generation_id;
          return {source};
        },compute:async source=>{
          if(hooks.beforeOutputBuild) await hooks.beforeOutputBuild();
          // Bound the unrepeated source before building narratives; then bound each full serialization.
          boundedOutput({text:source.capture.text,rows:source.rows});
          const summary=buildSummary(source);boundedOutput({...summary,...metadata});
          if(format==='summary') return boundedOutput({...summary,...metadata});
          const bundle=buildFHIR(summary,source);const buffer=boundedOutput(bundle);preflightFHIR(bundle,summary,source);return buffer;
        },recheck:(ctx,snapshot)=>{
          const current=capture(ctx);
          if(current.context_hash!==snapshot.source.context_hash) throw new ApiError('OUTPUT_CONTEXT_CHANGED');
        },audit:(ctx,snapshot)=>({patient_id:ctx.encounter.patient_id,encounter_id:encounterId,operation:format==='summary'?'SUMMARY_RELEASE':'FHIR_RELEASE',result:'AUTHORIZED',
          details:{draft_id:snapshot.source.draft.draft_id,event_ids:snapshot.source.rows.map(row=>row.event.event_id),generation_id:snapshot.source.generation_id,
            mapping_version:'local-r4-v1',validation_status:'NOT_RUN',as_of_sequence:snapshot.source.as_of_sequence,head_hash:snapshot.source.head_hash,
            ...(ctx.grant?{grant_id:ctx.grant.grant_id,mode:ctx.grant.mode}:{})}})});
      return {...result,generationId};
    } finally {inFlight=false;}
  }
  return {generate,get inFlight(){return inFlight?1:0;}};
}
