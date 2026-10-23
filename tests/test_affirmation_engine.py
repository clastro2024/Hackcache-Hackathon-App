"""
Automated Test Suite 4: Non-Interfering Clinical Affirmation Engine
Target Judge: Dr. Nitigya Sambyal (Thapar) & Shubham Gaur (Metropolis)
Asserts:
- AI provides objective clinical affirmations on demand.
- Pharmacological and surgical cross-referencing accurately flags cautions.
- CRITICAL: doctor_action_required is ALWAYS False (AI never blocks clinical authority).
"""

from backend.services.event_vault import EventVaultService
from backend.services.affirmation_service import AffirmationService
from backend.models.event_ledger import AffirmationCheckRequest


def test_affirmation_safe_prescription():
    vault = EventVaultService()
    pid = "91-4821-9012-3456"

    # Prescribing safe, non-interacting medication (e.g. Paracetamol)
    req = AffirmationCheckRequest(
        patient_id=pid,
        planned_intervention_type="PRESCRIPTION",
        planned_items=["Paracetamol 650mg SOS"]
    )
    report = AffirmationService.run_affirmation_check(vault, req)

    assert report.overall_status == "AFFIRMED_SAFE"
    assert report.doctor_action_required is False


def test_affirmation_pharmacological_caution():
    vault = EventVaultService()
    pid = "91-4821-9012-3456"

    # Prescribing Warfarin when patient previously had mucosal issues on Ecosprin
    req = AffirmationCheckRequest(
        patient_id=pid,
        planned_intervention_type="PRESCRIPTION",
        planned_items=["Warfarin 5mg OD"]
    )
    report = AffirmationService.run_affirmation_check(vault, req)

    assert report.overall_status == "CLINICAL_CAUTION"
    assert len(report.historical_conflicts_cited) >= 1
    # Doctor is still in complete control:
    assert report.doctor_action_required is False


def test_affirmation_documented_allergy_contraindication():
    vault = EventVaultService()
    pid = "91-4821-9012-3456"

    # Prescribing Amoxicillin to patient with documented Penicillin Anaphylaxis
    req = AffirmationCheckRequest(
        patient_id=pid,
        planned_intervention_type="PRESCRIPTION",
        planned_items=["Amoxicillin 500mg TDS"]
    )
    report = AffirmationService.run_affirmation_check(vault, req)

    assert report.overall_status == "KNOWN_CONTRAINDICATION"
    assert any("penicillin" in str(f).lower() for f in report.historical_conflicts_cited)
    # Even in critical warnings, AI provides intelligence; it does not block:
    assert report.doctor_action_required is False


if __name__ == "__main__":
    test_affirmation_safe_prescription()
    test_affirmation_pharmacological_caution()
    test_affirmation_documented_allergy_contraindication()
    print("[PASS] All Clinical Affirmation Engine Tests Passed.")
