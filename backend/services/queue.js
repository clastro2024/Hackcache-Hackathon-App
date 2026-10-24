import { randomUUID } from 'node:crypto';
import { ApiError } from '../schemas.js';
import { appendAudit } from './audit.js';
import { canonicalJSON, parseJSON } from './vault.js';

const fail=code=>{throw new ApiError(code);};
const iso=time=>time===null?null:new Date(time).toISOString();
const waitingStates=['WAITING','TRANSFERRED','RECALLED'];
const terminal=state=>['COMPLETED','CANCELLED'].includes(state);

// Sample walkways are bidirectional; reverse directions name the actual destination.
export function findRoute(map,{origin,destination,accessibility='STANDARD',language='en'}) {
  const nodes=new Map(map.nodes.map(node=>[node.node_id,node]));
  if(!nodes.has(origin) || !nodes.has(destination)) fail('VALIDATION_ERROR');
  const graph=new Map(map.nodes.map(node=>[node.node_id,[]]));
  for(const edge of map.edges) {
    if(accessibility==='STEP_FREE' && !edge.step_free) continue;
    graph.get(edge.from).push({to:edge.to,text:edge.instructions[language]});
    const node=nodes.get(edge.from);
    graph.get(edge.to).push({to:edge.from,text:language==='hi'?`${node.label.hi} की ओर लौटें (${node.floor})।`:`Return toward ${node.label.en} (${node.floor}).`});
  }
  const previous=new Map([[origin,null]]),queue=[origin];
  for(let i=0;i<queue.length && !previous.has(destination);i+=1) {
    for(const edge of graph.get(queue[i])) if(!previous.has(edge.to)) {previous.set(edge.to,{from:queue[i],text:edge.text});queue.push(edge.to);}
  }
  const found=previous.has(destination),steps=[];
  if(found) for(let node=destination;node!==origin;) {
    const edge=previous.get(node),landmark=nodes.get(node);
    steps.unshift({from:edge.from,to:node,landmark:landmark.label[language],floor:landmark.floor,instruction:edge.text});node=edge.from;
  }
  return {map_version:map.map_version,origin,destination,accessibility,language,status:found?'ROUTE_AVAILABLE':'NO_CONFIGURED_ROUTE',steps,
    warning:map.simulation_label,message:found?(language==='hi'?'नमूना मार्ग; आवश्यकता होने पर कर्मचारियों से सहायता लें।':'Sample route; ask staff for assistance when needed.'):
      (language==='hi'?'उपयुक्त नमूना मार्ग उपलब्ध नहीं है। कर्मचारियों से सहायता लें।':'No suitable configured route. Ask staff for assistance.')};
}

export function createQueue(store,auth,operations,consent,{now,map}) {
  const db=store.db;
  const room=id=>db.prepare('SELECT * FROM rooms WHERE room_id=?').get(id) ?? fail('RESOURCE_UNAVAILABLE');
  const visit=token=>db.prepare('SELECT * FROM visits WHERE token_id=?').get(token) ?? fail('RESOURCE_UNAVAILABLE');
  const waiting=id=>db.prepare('SELECT * FROM visits WHERE room_id=? AND queue_rank IS NOT NULL ORDER BY queue_rank').all(id);
  const current=id=>db.prepare("SELECT * FROM visits WHERE room_id=? AND queue_state='IN_CONSULTATION'").get(id);
  function capacity(roomId) {
    if(db.prepare("SELECT COUNT(*) n FROM visits WHERE room_id=? AND queue_state NOT IN ('COMPLETED','CANCELLED')").get(roomId).n>=100) fail('QUEUE_CAPACITY_REACHED');
  }
  function reorder(roomId,order) {
    const maximum=db.prepare('SELECT COALESCE(MAX(queue_rank),0) n FROM visits WHERE room_id=?').get(roomId).n;
    const offset=Math.max(maximum,order.length)+1;
    db.prepare('UPDATE visits SET queue_rank=queue_rank+? WHERE room_id=? AND queue_rank IS NOT NULL').run(offset,roomId);
    for(const [index,token] of order.entries()) db.prepare('UPDATE visits SET queue_rank=? WHERE room_id=? AND token_id=?').run(index+1,roomId,token);
  }
  function bump(roomId) {db.prepare('UPDATE rooms SET version=version+1 WHERE room_id=?').run(roomId);return room(roomId).version;}
  function placement(value) {
    if(value.queue_state==='IN_CONSULTATION') return {waiting_position:null,people_ahead:0};
    if(!waitingStates.includes(value.queue_state)) return {waiting_position:null,people_ahead:null};
    return {waiting_position:value.queue_rank,people_ahead:value.queue_rank-1+(current(value.room_id)?1:0)};
  }
  function result(value,status,versions,extra={}) {
    const position=placement(value),destination=room(value.room_id);
    return {status,changed:true,patient_id:value.patient_id,visit_id:value.visit_id,token_id:value.token_id,public_token:value.public_token,
      room_id:value.room_id,queue_state:value.queue_state,room_versions:versions,...position,
      message:`Token ${value.public_token}: ${destination.label}. ${position.people_ahead===null?'Ask staff for assistance.':`${position.people_ahead} people ahead.`}`,...extra};
  }
  function callAudit(ctx,e,value) {
    return appendAudit(store,{actor_id:ctx.actor.account_id,patient_id:value.patient_id,encounter_id:e.encounter_id,operation:'QUEUE_CALL',result:'RECORDED',recorded_at:ctx.now,
      details:{room_id:e.room_id,token_id:value.token_id,public_token:value.public_token,call_number:e.call_attempts}});
  }
  function callNext(ctx,roomId) {
    const next=waiting(roomId)[0];if(!next) return null;
    db.prepare("UPDATE visits SET queue_state='IN_CONSULTATION',queue_rank=NULL WHERE visit_id=?").run(next.visit_id);
    reorder(roomId,waiting(roomId).map(value=>value.token_id));
    const encounterId=`encounter_${randomUUID()}`,assigned=room(roomId).clinician_id;
    db.prepare('INSERT INTO encounters VALUES(?,?,?,?,?,?,1,?,NULL,NULL,NULL,NULL)').run(encounterId,next.visit_id,next.patient_id,roomId,assigned,ctx.now,ctx.now);
    const e=db.prepare('SELECT * FROM encounters WHERE encounter_id=?').get(encounterId);callAudit(ctx,e,next);return e;
  }
  function close(ctx,reason) {
    db.prepare('UPDATE encounters SET closed_at=?,closure_reason=? WHERE encounter_id=?').run(ctx.now,reason,ctx.encounter.encounter_id);
    consent.endEncounterAccess(ctx.encounter.encounter_id,reason,ctx.now,ctx.actor.account_id);
  }
  function authorize(ref,kind,target,body) {
    let ctx,value;
    if(['check-in','complete'].includes(kind)) {
      ctx=auth.encounter(ref,target,{permission:'queue:operate'});value=db.prepare('SELECT * FROM visits WHERE visit_id=?').get(ctx.encounter.visit_id);
    } else if(['repeat-call','absent','transfer','withdraw','recall'].includes(kind)) {
      value=visit(target);
      if(body.encounter_id) {
        ctx=auth.encounter(ref,body.encounter_id,{permission:'queue:operate'});
        if(ctx.encounter.visit_id!==value.visit_id) fail('RESOURCE_UNAVAILABLE');
      } else ctx=auth.room(ref,value.room_id,'queue:operate');
    } else ctx=auth.room(ref,kind==='register'?body.room_id:target,kind==='register'?'intake:register':'queue:operate');
    if(!ctx.room) ctx.room=room(ctx.encounter.room_id);
    if(['transfer','complete'].includes(kind) && ctx.actor.role!=='CLINICIAN') fail('SCOPE_DENIED');
    if(['register','recall'].includes(kind) && ctx.actor.role!=='STAFF') fail('SCOPE_DENIED');
    if(kind==='withdraw' && ctx.actor.role==='CLINICIAN' && !ctx.encounter) fail('SCOPE_DENIED');
    if(kind==='withdraw' && ctx.encounter?.checked_in_at!==undefined && ctx.encounter.checked_in_at!==null && ctx.actor.role!=='CLINICIAN') fail('SCOPE_DENIED');
    if(kind==='register' && body.patient_id && !db.prepare('SELECT patient_id FROM patients WHERE patient_id=?').get(body.patient_id)) fail('RESOURCE_UNAVAILABLE');
    if(kind==='transfer') room(body.target_room_id); // configured destination, not permission to read its patients.
    return {...ctx,visit:value};
  }
  function currentEncounter(ctx) {
    if(!ctx.encounter || ctx.encounter.closed_at!==null || ctx.visit.queue_state!=='IN_CONSULTATION' ||
      ctx.visit.room_id!==ctx.encounter.room_id || current(ctx.room.room_id)?.visit_id!==ctx.visit.visit_id) fail('INVALID_TRANSITION');
  }
  async function command(ref,intent,kind,target) {
    const body=intent.body;
    const outcome=await operations.executeCommand(ref,intent,()=>authorize(ref,kind,target,body),ctx=>{
      const source=ctx.room.room_id;
      if(ctx.visit && ctx.visit.room_id!==source) fail('INVALID_TRANSITION');
      if(kind!=='register' && ctx.room.version!==body.expected_version) fail('STATE_VERSION_CONFLICT');
      if(kind==='register') {
        capacity(source);
        if(body.patient?.date_of_birth && body.patient.date_of_birth>iso(ctx.now).slice(0,10)) fail('VALIDATION_ERROR');
        const patientId=body.patient_id ?? `patient_${randomUUID()}`;
        if(body.patient_id && db.prepare("SELECT visit_id FROM visits WHERE patient_id=? AND queue_state NOT IN ('COMPLETED','CANCELLED')").get(patientId)) fail('ACTIVE_VISIT_EXISTS');
        if(body.patient) db.prepare('INSERT INTO patients VALUES(?,?,?,?,?,?)').run(patientId,body.patient.display_name,body.patient.date_of_birth ?? null,
          body.patient.language,body.demo_identifier ?? null,ctx.now);
        const number=db.prepare('SELECT next_token_number FROM schema_meta WHERE singleton=1').get().next_token_number;
        if(!Number.isSafeInteger(number) || number>=Number.MAX_SAFE_INTEGER) fail('DEPENDENCY_UNAVAILABLE');
        db.prepare('UPDATE schema_meta SET next_token_number=next_token_number+1 WHERE singleton=1').run();
        const visitId=`visit_${randomUUID()}`,tokenId=`token_${randomUUID()}`,rank=waiting(source).length+1;
        db.prepare("INSERT INTO visits VALUES(?,?,?,?,?,'WAITING',?,?,?,?)").run(visitId,patientId,tokenId,`OPD-${String(number).padStart(3,'0')}`,source,rank,
          canonicalJSON({intake_mode:body.intake_mode,simulation_label:body.intake_mode==='SIMULATED_ABHA'?'SIMULATED_ABHA_NOT_VERIFIED':'FICTIONAL_MANUAL_INTAKE',
            ...(body.demo_identifier?{demo_identifier:body.demo_identifier}:{})}),canonicalJSON({room_id:source,node_id:ctx.room.map_node,map_version:map.map_version}),ctx.now);
        return result(visit(tokenId),'REGISTERED',{[source]:bump(source)});
      }
      if(kind==='pause' || kind==='resume') {
        const expected=kind==='pause'?'ACTIVE':'PAUSED_ON_BREAK';if(ctx.room.service_state!==expected) fail('INVALID_TRANSITION');
        const estimate=body.estimated_return_at?Date.parse(body.estimated_return_at):null;
        if(estimate!==null && estimate<=ctx.now) fail('VALIDATION_ERROR');
        db.prepare('UPDATE rooms SET service_state=?,delay_reason=?,estimated_return_at=? WHERE room_id=?').run(
          kind==='pause'?'PAUSED_ON_BREAK':'ACTIVE',kind==='pause'?'DOCTOR_BREAK':null,estimate,source);
        return {status:kind==='pause'?'PAUSED_ON_BREAK':'RESUMED',changed:true,room_id:source,room_versions:{[source]:bump(source)}};
      }
      if(kind==='call-next') {
        if(ctx.room.service_state!=='ACTIVE' || current(source)) fail('INVALID_TRANSITION');
        const e=callNext(ctx,source);
        if(!e) return {status:'NO_WAITING_TOKEN',changed:false,room_id:source,room_versions:{[source]:ctx.room.version}};
        return result(db.prepare('SELECT * FROM visits WHERE visit_id=?').get(e.visit_id),'CALLED',{[source]:bump(source)},{encounter_id:e.encounter_id});
      }
      if(kind==='recall') {
        if(ctx.visit.queue_state!=='SKIPPED_ABSENT') fail('INVALID_TRANSITION');
        const last=db.prepare('SELECT closed_at,closure_reason FROM encounters WHERE visit_id=? ORDER BY called_at DESC,rowid DESC LIMIT 1').get(ctx.visit.visit_id);
        if(last?.closed_at===null || last?.closure_reason!=='ABSENT') fail('INVALID_TRANSITION');
        const order=waiting(source),index=order.filter(value=>value.queue_state==='RECALLED').length;
        const tokens=order.map(value=>value.token_id);tokens.splice(index,0,ctx.visit.token_id);
        db.prepare("UPDATE visits SET queue_state='RECALLED',queue_rank=? WHERE token_id=?").run(order.length+1,ctx.visit.token_id);
        reorder(source,tokens);return result(visit(ctx.visit.token_id),'RECALLED',{[source]:bump(source)});
      }
      if(kind==='withdraw') {
        if(terminal(ctx.visit.queue_state)) fail('INVALID_TRANSITION');
        if(ctx.visit.queue_state!=='IN_CONSULTATION' && body.encounter_id) fail('INVALID_TRANSITION');
        if(ctx.visit.queue_state==='IN_CONSULTATION') {
          currentEncounter(ctx);
          if(ctx.encounter.checked_in_at!==null && ctx.actor.role!=='CLINICIAN') fail('SCOPE_DENIED');
          close(ctx,'WITHDRAWN');
        } else if(ctx.actor.role!=='STAFF') fail('SCOPE_DENIED');
        db.prepare("UPDATE visits SET queue_state='CANCELLED',queue_rank=NULL WHERE token_id=?").run(ctx.visit.token_id);
        reorder(source,waiting(source).map(value=>value.token_id));
        return result(visit(ctx.visit.token_id),'CANCELLED',{[source]:bump(source)},ctx.encounter?{closed_encounter_id:ctx.encounter.encounter_id}:{});
      }
      currentEncounter(ctx);
      if(kind==='repeat-call') {
        if(ctx.room.service_state!=='ACTIVE' || ctx.encounter.checked_in_at!==null || ctx.encounter.call_attempts>=3) fail('INVALID_TRANSITION');
        db.prepare('UPDATE encounters SET call_attempts=call_attempts+1,last_called_at=? WHERE encounter_id=?').run(ctx.now,ctx.encounter.encounter_id);
        callAudit(ctx,{...ctx.encounter,call_attempts:ctx.encounter.call_attempts+1},ctx.visit);
        return result(ctx.visit,'CALL_RECORDED',{[source]:bump(source)},{encounter_id:ctx.encounter.encounter_id});
      }
      if(kind==='check-in') {
        if(ctx.encounter.checked_in_at!==null) fail('INVALID_TRANSITION');
        db.prepare('UPDATE encounters SET checked_in_at=?,checked_in_by=? WHERE encounter_id=?').run(ctx.now,ctx.actor.account_id,ctx.encounter.encounter_id);
        return result(ctx.visit,'CHECKED_IN',{[source]:bump(source)},{encounter_id:ctx.encounter.encounter_id});
      }
      if(kind==='absent') {
        if(ctx.encounter.checked_in_at!==null || ctx.encounter.call_attempts!==3) fail('INVALID_TRANSITION');
        close(ctx,'ABSENT');db.prepare("UPDATE visits SET queue_state='SKIPPED_ABSENT',queue_rank=NULL WHERE token_id=?").run(ctx.visit.token_id);
        const next=ctx.room.service_state==='ACTIVE'?callNext(ctx,source):null;
        const nextToken=next?db.prepare('SELECT token_id FROM visits WHERE visit_id=?').get(next.visit_id).token_id:null;
        return result(visit(ctx.visit.token_id),'SKIPPED_ABSENT',{[source]:bump(source)},
          {closed_encounter_id:ctx.encounter.encounter_id,called_token_id:nextToken,called_encounter_id:next?.encounter_id ?? null});
      }
      if(ctx.encounter.checked_in_at===null) fail('INVALID_TRANSITION');
      if(kind==='complete') {
        close(ctx,'COMPLETED');db.prepare("UPDATE visits SET queue_state='COMPLETED',queue_rank=NULL WHERE token_id=?").run(ctx.visit.token_id);
        return result(visit(ctx.visit.token_id),'COMPLETED',{[source]:bump(source)},{closed_encounter_id:ctx.encounter.encounter_id});
      }
      const targetRoom=room(body.target_room_id);
      if(targetRoom.room_id===source) fail('INVALID_TRANSITION');
      if(targetRoom.version!==body.expected_target_version) fail('STATE_VERSION_CONFLICT');capacity(targetRoom.room_id);
      const order=waiting(targetRoom.room_id),recalls=order.filter(value=>value.queue_state==='RECALLED').length;
      const tokens=order.map(value=>value.token_id);tokens.splice(Math.max(recalls,order.length-2),0,ctx.visit.token_id);
      close(ctx,'TRANSFERRED');
      db.prepare("UPDATE visits SET room_id=?,queue_state='TRANSFERRED',queue_rank=?,next_destination_json=? WHERE token_id=?")
        .run(targetRoom.room_id,order.length+1,canonicalJSON({room_id:targetRoom.room_id,node_id:targetRoom.map_node,map_version:map.map_version}),ctx.visit.token_id);
      reorder(targetRoom.room_id,tokens);
      return result(visit(ctx.visit.token_id),'TRANSFERRED',{[source]:bump(source),[targetRoom.room_id]:bump(targetRoom.room_id)},
        {closed_encounter_id:ctx.encounter.encounter_id});
    },{audit:(ctx,value)=>({patient_id:value.patient_id ?? null,encounter_id:value.encounter_id ?? value.closed_encounter_id ?? null,
      operation:`QUEUE_${kind.replaceAll('-','_').toUpperCase()}`,result:value.status,details:{room_id:ctx.room.room_id,changed:value.changed,
        ...(body.target_room_id?{target_room_id:body.target_room_id}:{}),...(value.token_id?{token_id:value.token_id}:{}),
        ...(value.visit_id?{visit_id:value.visit_id}:{}),...(body.reason?{reason:body.reason}:{}),
        ...(kind==='check-in'?{identity_check_method:'FICTIONAL_VISIT_DETAILS_CONFIRMED'}:{})}})});
    return {...outcome,outcome:outcome.status};
  }
  function snapshot(roomId,operational) {
    const r=room(roomId),values=db.prepare("SELECT v.*,p.display_name FROM visits v JOIN patients p ON p.patient_id=v.patient_id WHERE v.room_id=? AND v.queue_state NOT IN ('COMPLETED','CANCELLED') ORDER BY v.queue_rank,v.created_at,v.visit_id").all(roomId);
    if(values.length>100) fail('DEPENDENCY_UNAVAILABLE');
    const item=value=>({public_token:value.public_token,queue_state:value.queue_state,...placement(value),...(operational?{
      token_id:value.token_id,visit_id:value.visit_id,patient_id:value.patient_id,display_name:value.display_name}:{})});
    const active=values.find(value=>value.queue_state==='IN_CONSULTATION');
    let currentValue=active?item(active):null;
    if(operational && active) {
      const e=db.prepare('SELECT encounter_id,call_attempts,checked_in_at FROM encounters WHERE visit_id=? AND closed_at IS NULL').get(active.visit_id);
      if(!e) fail('DEPENDENCY_UNAVAILABLE');currentValue={...currentValue,...e,checked_in:e.checked_in_at!==null};
    }
    const changed=db.prepare("SELECT MAX(recorded_at) t FROM audit_events WHERE operation LIKE 'QUEUE_%' AND json_extract(details_json,'$.changed')=1 AND (json_extract(details_json,'$.room_id')=? OR json_extract(details_json,'$.target_room_id')=?)").get(roomId,roomId).t ??
      db.prepare('SELECT created_at FROM schema_meta WHERE singleton=1').get().created_at;
    const common={room_id:roomId,label:r.label,version:r.version,service_state:r.service_state,estimated_return_at:iso(r.estimated_return_at),
      delay_message:r.service_state==='PAUSED_ON_BREAK'?'Doctor on break. Ask staff for updates.':null,state_changed_at:iso(changed),
      current:currentValue,waiting:values.filter(value=>value.queue_rank!==null).sort((a,b)=>a.queue_rank-b.queue_rank).map(item)};
    if(operational) return {...common,absent:values.filter(value=>value.queue_state==='SKIPPED_ABSENT').map(item)};
    const call=db.prepare("SELECT audit_id,details_json FROM audit_events WHERE operation='QUEUE_CALL' AND json_extract(details_json,'$.room_id')=? ORDER BY audit_id DESC LIMIT 1").get(roomId);
    const details=call?parseJSON(call.details_json,16384):null;
    return {...common,announcement:call?{announcement_id:String(call.audit_id),public_token:details.public_token,room_label:r.label,
      call_number:details.call_number,text:`Token ${details.public_token}, please go to ${r.label}. Call ${details.call_number}.`}:null};
  }
  function patientVisit(ref) {
    const ctx=auth.authenticate(ref);if(ctx.actor.role!=='PATIENT') fail('SCOPE_DENIED');auth.ownPatient(ref,ctx.actor.patient_id);
    const v=db.prepare('SELECT * FROM visits WHERE patient_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(ctx.actor.patient_id);
    if(!v) return {visit:null};const r=room(v.room_id);
    const latest=db.prepare('SELECT * FROM encounters WHERE visit_id=? ORDER BY called_at DESC,rowid DESC LIMIT 1').get(v.visit_id);
    const active=latest?.closed_at===null && v.queue_state==='IN_CONSULTATION'?latest:null;
    return {visit:{patient_id:v.patient_id,visit_id:v.visit_id,token_id:v.token_id,public_token:v.public_token,room_id:v.room_id,room_label:r.label,
      queue_state:v.queue_state,room_version:r.version,service_state:r.service_state,...placement(v),
      destination:v.next_destination_json?parseJSON(v.next_destination_json,8192):{room_id:r.room_id,node_id:r.map_node,map_version:map.map_version},
      map_version:map.map_version,simulation_label:map.simulation_label,encounter_id:active?.encounter_id ?? null,latest_encounter_id:latest?.encounter_id ?? null,
      allowance:active?consent.statusInUnit({...ctx,encounter:active}):null}};
  }
  return {command,route:query=>findRoute(map,query),
    room:(ref,roomId)=>store.runUnit(false,()=>{auth.room(ref,roomId,'queue:operate');return snapshot(roomId,true);}),
    display:roomId=>store.runUnit(false,()=>snapshot(roomId,false)),patientVisit:ref=>store.runUnit(false,()=>patientVisit(ref))};
}
