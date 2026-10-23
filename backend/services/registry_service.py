"""
VaultMed Backend: National Medical Council (NMC) Registry Service
Simulates real-time verification of doctor medical registration numbers.
"""

from typing import Dict, Any, Optional
from backend.models.schemas import DoctorVerificationResponse

# Pre-seeded Verified Registry Database (National Medical Commission & State Medical Councils)
VERIFIED_DOCTOR_REGISTRY: Dict[str, Dict[str, Any]] = {
    "NMC-2018-094821": {
        "doctor_name": "Dr. Rajesh Sharma",
        "qualification": "MBBS, MD (Internal Medicine)",
        "council": "Delhi Medical Council (NMC Recognized)",
        "registration_year": 2018,
        "status": "ACTIVE_PRACTICING",
        "hospital_affiliations": ["Apex Multispeciality Hospital", "Max Super Speciality"]
    },
    "NMC-2015-110482": {
        "doctor_name": "Dr. Ananya Sen",
        "qualification": "MBBS, MS (General & Laparoscopic Surgery)",
        "council": "West Bengal Medical Council (NMC Recognized)",
        "registration_year": 2015,
        "status": "ACTIVE_PRACTICING",
        "hospital_affiliations": ["Apollo Multispeciality Hospitals"]
    },
    "NMC-2020-041928": {
        "doctor_name": "Dr. Vikram Verma",
        "qualification": "MBBS, MD (Emergency Medicine & Critical Care)",
        "council": "Maharashtra Medical Council (NMC Recognized)",
        "registration_year": 2020,
        "status": "ACTIVE_PRACTICING",
        "hospital_affiliations": ["Lilavati Hospital & Research Centre"]
    }
}


class DoctorRegistryService:
    @staticmethod
    def verify_doctor_id(registration_id: str) -> DoctorVerificationResponse:
        cleaned_id = registration_id.strip().upper()

        if cleaned_id in VERIFIED_DOCTOR_REGISTRY:
            doc_data = VERIFIED_DOCTOR_REGISTRY[cleaned_id]
            return DoctorVerificationResponse(
                registration_id=cleaned_id,
                doctor_name=doc_data["doctor_name"],
                qualification=doc_data["qualification"],
                council=doc_data["council"],
                is_valid=True,
                status_message="VERIFIED_ACTIVE_PRACTITIONER"
            )

        return DoctorVerificationResponse(
            registration_id=cleaned_id,
            doctor_name="UNKNOWN / UNVERIFIED",
            qualification="N/A",
            council="N/A",
            is_valid=False,
            status_message="REGISTRATION_ID_NOT_FOUND_IN_NMC_REGISTRY"
        )
