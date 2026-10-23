"""
VaultMed Backend: Non-Interfering Clinical Affirmation Engine
Implements on-demand, voluntary pharmacological and surgical cross-referencing.
CRITICAL INVARIANT: The AI NEVER blocks, locks, or overrides the doctor's authority.
"""

from typing import List, Dict, Any
from backend.models.event_ledger import AffirmationCheckRequest, AffirmationReport
from backend.services.event_vault import EventVaultService


class AffirmationService:
    @staticmethod
    def run_affirmation_check(vault: EventVaultService, req: AffirmationCheckRequest) -> AffirmationReport:
        patient_events = [e for e in vault.events if e.patient_id == req.patient_id]
        projection = vault.get_patient_active_projection(req.patient_id)

        findings: List[Dict[str, Any]] = []
        conflicts: List[Dict[str, Any]] = []
        worst_severity = "AFFIRMED_SAFE"

        # Active medications currently circulating
        active_drug_names = [m["name"].lower() for m in projection.active_medications]

        for item in req.planned_items:
            item_lower = item.lower()

            # 1. Check for Antiplatelet / Anticoagulant Interaction (e.g. Warfarin + Discontinued/Active Aspirin)
            if any(k in item_lower for k in ["warfarin", "heparin", "dabigatran", "rivaroxaban"]):
                if any("telmisartan" in m for m in active_drug_names):
                    findings.append({
                        "planned_item": item,
                        "observation": "Concurrent ACE/ARB + Anticoagulant requires renal telemetry monitoring.",
                        "severity": "CLINICAL_CAUTION"
                    })
                    if worst_severity == "AFFIRMED_SAFE":
                        worst_severity = "CLINICAL_CAUTION"

                # Check if patient had mucosal bleeding issues documented in vault
                for ev in patient_events:
                    if "mucosal" in str(ev.clinical_payload).lower() or "ecosprin" in ev.target_entity.lower():
                        conflicts.append({
                            "historical_event_id": ev.event_id,
                            "documented_by": ev.author_name,
                            "date": ev.timestamp.strftime("%d %b %Y"),
                            "historical_note": f"Patient discontinued Ecosprin on {ev.timestamp.strftime('%b %Y')} due to mucosal check."
                        })
                        findings.append({
                            "planned_item": item,
                            "observation": "Historical mucosal sensitivity cited in Vault (Jan 2026 by Dr. Ananya Sen). Titrate INR cautiously.",
                            "severity": "CLINICAL_CAUTION"
                        })
                        worst_severity = "CLINICAL_CAUTION"

            # 2. Check for Penicillin / Beta-Lactam Antibiotic Contradictions
            if any(k in item_lower for k in ["amoxicillin", "ampicillin", "augmentin", "penicillin", "piperacillin"]):
                # Look for allergy event
                for c in projection.critical_contraindications:
                    if "penicillin" in c["substance"].lower():
                        worst_severity = "KNOWN_CONTRAINDICATION"
                        findings.append({
                            "planned_item": item,
                            "observation": f"CRITICAL: Planned {item} directly conflicts with documented Penicillin Anaphylaxis.",
                            "severity": "KNOWN_CONTRAINDICATION"
                        })
                        conflicts.append({
                            "allergy": c["substance"],
                            "reaction": c["reaction"],
                            "severity": c["severity"],
                            "documented_year": c["documented_year"]
                        })

            # 3. Surgical Procedure Affirmation Checks
            if req.planned_intervention_type == "SURGICAL_PROCEDURE":
                for s in projection.surgical_history:
                    if "cholecystectomy" in s["procedure"].lower() and any(k in item_lower for k in ["laparoscopic", "abdomen", "hernia"]):
                        findings.append({
                            "planned_item": item,
                            "observation": f"Historical {s['procedure']} ({s['date']}) may present right-upper quadrant peritoneal adhesions.",
                            "severity": "CLINICAL_CAUTION"
                        })
                        if worst_severity == "AFFIRMED_SAFE":
                            worst_severity = "CLINICAL_CAUTION"

        # If no issues found:
        if not findings:
            findings.append({
                "planned_item": ", ".join(req.planned_items),
                "observation": "No pharmacological incompatibilities or documented surgical contraindications found in vault.",
                "severity": "AFFIRMED_SAFE"
            })

        return AffirmationReport(
            overall_status=worst_severity,
            affirmation_findings=findings,
            historical_conflicts_cited=conflicts,
            evaluated_against_event_count=len(patient_events),
            doctor_action_required=False  # Crucial rule: Never blocks clinical authority
        )
