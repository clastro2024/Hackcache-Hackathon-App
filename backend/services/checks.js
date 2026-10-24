import { citation, project } from './vault.js';

// No clinical rule has both authoritative provenance and clinician approval in this repository.
// Expose that coverage through the protected, audited read path; never manufacture an all-clear.
export function runChecks(vault,ref,intent) {
  const {patient_id:patientId,encounter_id:encounterId,intervention_type,planned_items}=intent.body;
  return vault.read(ref,{patientId,encounterId,kind:'checks',intent,compute:(source,shared)=>({...shared,
    check_id:source.outcome.query_id,ruleset_version:'no-active-clinical-rules-v1',evaluation_status:'NOT_EVALUATED',
    intervention_type,planned_items,findings:[],source_citations:Object.values(project(source,Date.parse(source.outcome.committed_at)).clinical_data)
      .filter(Array.isArray).flat().filter(event=>event && typeof event==='object').map(citation),
    unsupported_areas:['No sourced, clinician-reviewed clinical interaction rules are activated.'],
    warnings:['No treatment recommendation or safety verdict is available. Missing history is not absence.'],
    doctor_action_required:false})});
}
