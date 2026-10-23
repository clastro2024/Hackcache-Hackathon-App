"""
VaultMed Backend: Sarvam Indic Scribe & Clinical Entity Parsing Service
Simulates Sarvam AI Indic Speech-to-Text with clinical entity extraction
and ABDM FHIR R4 bundle construction.
"""

from typing import Dict, Any, List
from datetime import datetime, timezone


class SarvamScribeService:
    @staticmethod
    def process_voice_dictation(audio_bytes: bytes, language_hint: str = "hi-IN") -> Dict[str, Any]:
        """
        Processes Indic clinical audio stream via Sarvam AI ASR,
        returning transcribed text and decomposed clinical entities.
        """
        # Deterministic Indic clinical transcription simulation
        transcription_hindi = (
            "Patient ko acute dyspepsia ki problem hai. Pantocid 40 BD start kiya hai "
            "aur pehle ka Ranitidine band kar diya. 2021 mein gallbladder ki cholecystectomy hui thi. "
            "Follow up in 7 days."
        )

        extracted_entities = {
            "new_active_medications": [
                {
                    "brand_name": "Pantocid 40",
                    "molecule": "Pantoprazole",
                    "dosage": "40mg",
                    "frequency": "BD (Twice Daily)",
                    "rxnorm_cui": "205934",
                    "snomed_code": "372658004"
                }
            ],
            "discontinued_medications": [
                {
                    "brand_name": "Ranitidine",
                    "rationale": "Superseded by Pantoprazole for acute dyspepsia"
                }
            ],
            "historical_procedures": [
                {
                    "procedure_name": "Cholecystectomy",
                    "year": "2021",
                    "snomed_code": "3726580"
                }
            ],
            "assigned_diagnosis": {
                "condition": "Acute Dyspepsia",
                "snomed_code": "54586004"
            }
        }

        fhir_r4_bundle = {
            "resourceType": "Bundle",
            "type": "document",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "entry": [
                {
                    "resource": {
                        "resourceType": "MedicationRequest",
                        "status": "active",
                        "intent": "order",
                        "medicationCodeableConcept": {
                            "coding": [{"system": "http://snomed.info/sct", "code": "372658004", "display": "Pantoprazole 40mg"}]
                        }
                    }
                },
                {
                    "resource": {
                        "resourceType": "Condition",
                        "code": {
                            "coding": [{"system": "http://snomed.info/sct", "code": "54586004", "display": "Dyspepsia"}]
                        }
                    }
                }
            ]
        }

        return {
            "transcription": transcription_hindi,
            "confidence_score": 0.964,
            "extracted_entities": extracted_entities,
            "fhir_r4_bundle": fhir_r4_bundle,
            "asr_engine": "Sarvam-AI-Indic-Speech-v2"
        }
