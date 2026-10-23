"""
VaultMed Backend: Granular Per-Question Consent Gateway
Manages the real-time lifecycle of patient consent requests (Allow / Deny / Ask Why).
"""

import uuid
import time
from typing import Dict, Any, Optional
from datetime import datetime, timezone
from backend.models.schemas import ConsentActionResponse


class ConsentService:
    def __init__(self):
        # Ephemeral active consent requests store (TTL: 120 seconds)
        self.active_requests: Dict[str, Dict[str, Any]] = {}

    def create_consent_request(
        self,
        patient_id: str,
        doctor_name: str,
        clinic_name: str,
        question_text: str
    ) -> str:
        request_id = f"cst_{uuid.uuid4().hex[:10]}"
        self.active_requests[request_id] = {
            "consent_request_id": request_id,
            "patient_id": patient_id,
            "doctor_name": doctor_name,
            "clinic_name": clinic_name,
            "question_text": question_text,
            "status": "PENDING_PATIENT_ACTION",
            "created_at": time.time(),
            "expires_at": time.time() + 120.0,
            "clarification_requested": False,
            "doctor_rationale": None,
            "ephemeral_access_token": None
        }
        return request_id

    def get_pending_request_for_patient(self, patient_id: str) -> Optional[Dict[str, Any]]:
        now = time.time()
        for req in self.active_requests.values():
            if req["patient_id"] == patient_id and req["status"] == "PENDING_PATIENT_ACTION" and req["expires_at"] > now:
                return req
        return None

    def record_patient_action(self, consent_request_id: str, action: str) -> ConsentActionResponse:
        req = self.active_requests.get(consent_request_id)
        if not req:
            return ConsentActionResponse(
                consent_request_id=consent_request_id,
                action_recorded="EXPIRED",
                is_authorized=False,
                message="Consent request not found or expired."
            )

        if action == "ALLOW":
            token = f"tok_{uuid.uuid4().hex}"
            req["status"] = "APPROVED"
            req["ephemeral_access_token"] = token
            return ConsentActionResponse(
                consent_request_id=consent_request_id,
                action_recorded="ALLOW",
                is_authorized=True,
                ephemeral_access_token=token,
                message="Patient granted explicit per-question authorization."
            )

        elif action == "DENY":
            req["status"] = "DENIED"
            return ConsentActionResponse(
                consent_request_id=consent_request_id,
                action_recorded="DENY",
                is_authorized=False,
                message="Patient explicitly denied access under DPDP Rule 4.2."
            )

        elif action == "ASK_WHY":
            req["clarification_requested"] = True
            return ConsentActionResponse(
                consent_request_id=consent_request_id,
                action_recorded="ASK_WHY",
                is_authorized=False,
                message="Clinical justification requested by patient."
            )

        return ConsentActionResponse(
            consent_request_id=consent_request_id,
            action_recorded="UNKNOWN",
            is_authorized=False,
            message="Unrecognized action."
        )

    def submit_doctor_justification(self, consent_request_id: str, rationale: str) -> bool:
        req = self.active_requests.get(consent_request_id)
        if req:
            req["doctor_rationale"] = rationale
            return True
        return False
