"""
VaultMed Backend: API Contracts & Schemas
Request and response models for queries, consent, Break-Glass, and audit logs.
Works seamlessly with both standard library dataclasses and Pydantic.
"""

from typing import Optional, List, Dict, Any
from datetime import datetime, timezone

try:
    from pydantic import BaseModel, Field
except ImportError:
    class BaseModel:
        def __init__(self, **kwargs):
            for k, v in kwargs.items():
                setattr(self, k, v)
        def model_dump(self):
            return self.__dict__
        def dict(self):
            return self.__dict__
    def Field(default=None, **kwargs):
        return default


class QuestionQueryRequest(BaseModel):
    patient_id: str
    doctor_name: str
    clinic_name: str
    question_text: str
    mode: str = "STANDARD"
    doctor_registration_id: Optional[str] = None
    emergency_rationale: Optional[str] = None


class QuestionQueryResponse(BaseModel):
    query_id: str
    patient_id: str
    question_text: str
    status: str
    certainty_state: Optional[str] = None
    answer_text: Optional[str] = None
    source_citations: List[Dict[str, Any]] = []
    consent_request_id: Optional[str] = None
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class DoctorVerificationRequest(BaseModel):
    registration_id: str
    council: Optional[str] = "National Medical Commission (NMC)"


class DoctorVerificationResponse(BaseModel):
    registration_id: str
    doctor_name: str
    qualification: str
    council: str
    is_valid: bool
    status_message: str


class ConsentActionRequest(BaseModel):
    consent_request_id: str
    action: str
    clarification_note: Optional[str] = None


class ConsentActionResponse(BaseModel):
    consent_request_id: str
    action_recorded: str
    is_authorized: bool
    ephemeral_access_token: Optional[str] = None
    message: str


class ClarificationResponseRequest(BaseModel):
    consent_request_id: str
    clinical_rationale: str


class AuditLogEntry(BaseModel):
    query_id: str
    timestamp: datetime
    patient_id: str
    doctor_name: str
    doctor_registration_id: Optional[str] = None
    access_type: str = "STANDARD_CONSENT"
    question_text: str
    data_retrieved: str
    certainty_state: str
    patient_notified: bool = True
