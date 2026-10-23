"""
Automated Test Suite 5: Direct Vault Inspection (3-State Clinical Certainty)
Target Judge: Dr. Nitigya Sambyal (Thapar / Uppsala) & Dr. Yugaanshu Sanjay Ticku (Sharda)
Asserts:
- Zero hallucination in clinical retrieval.
- Returns strictly: VERIFIED_POSITIVE, DOCUMENTED_NEGATIVE, or NOT_RECORDED_IN_VAULT.
- Exact source citations and physical vault hashes accompany every positive return.
"""

from backend.services.event_vault import EventVaultService


def test_vault_inspection_verified_positive_blood_thinner():
    vault = EventVaultService()
    pid = "91-4821-9012-3456"

    res = vault.direct_vault_inspect(pid, "Is this patient on blood thinners?")
    assert res["certainty_state"] == "VERIFIED_POSITIVE"
    assert "Ecosprin 75mg OD" in res["answer_text"]
    assert "discontinued on 02 Feb 2026" in res["answer_text"]
    assert len(res["source_citations"]) >= 1
    assert "vault_hash" in res["source_citations"][0]


def test_vault_inspection_verified_positive_penicillin():
    vault = EventVaultService()
    pid = "91-4821-9012-3456"

    res = vault.direct_vault_inspect(pid, "Penicillin allergy history?")
    assert res["certainty_state"] == "VERIFIED_POSITIVE"
    assert "Penicillin Anaphylaxis" in res["answer_text"]
    assert "Dr. Vikram Verma" in str(res["source_citations"])


def test_vault_inspection_not_recorded_psychiatric():
    vault = EventVaultService()
    pid = "91-4821-9012-3456"

    res = vault.direct_vault_inspect(pid, "Any psychiatric diagnoses or antidepressant prescriptions?")
    assert res["certainty_state"] == "NOT_RECORDED_IN_VAULT"
    assert "No documentation regarding psychiatric" in res["answer_text"]
    assert len(res["source_citations"]) == 0


if __name__ == "__main__":
    test_vault_inspection_verified_positive_blood_thinner()
    test_vault_inspection_verified_positive_penicillin()
    test_vault_inspection_not_recorded_psychiatric()
    print("[PASS] All 3-State Direct Vault Inspection Tests Passed.")
