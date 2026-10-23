"""
VaultMed Backend: Event Ledger Models
Defines immutable append-only event schemas, state projections, and affirmation models.
Works seamlessly with both standard library dataclasses and Pydantic.
"""

from typing import Optional, Dict, Any, List
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


class VaultEvent(BaseModel):
    event_id: str
    patient_id: str
    event_type: str
    target_entity: str
    clinical_payload: Dict[str, Any]
    supersedes_event_id: Optional[str] = None
    provenance_tier: str = "TIER_2_CLINICIAN_VERIFIED"
    author_role: str = "CLINICIAN"
    author_identifier: str = "NMC-SYSTEM"
    author_name: str = "Attending Physician"
    facility_name: Optional[str] = "Independent Clinic"
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    event_hash: str = ""


class ActiveStateProjection(BaseModel):
    patient_id: str
    active_medications: List[Dict[str, Any]]
    discontinued_medications: List[Dict[str, Any]]
    surgical_history: List[Dict[str, Any]]
    chronic_conditions: List[Dict[str, Any]]
    critical_contraindications: List[Dict[str, Any]]
    latest_vitals: Dict[str, Any]
    total_events_in_chain: int
    last_projected_at: datetime


class AffirmationCheckRequest(BaseModel):
    patient_id: str
    doctor_registration_id: Optional[str] = None
    doctor_name: str = "Dr. Consulting Physician"
    planned_intervention_type: str = "PRESCRIPTION"
    planned_items: List[str] = []
    clinical_rationale: Optional[str] = None


class AffirmationReport(BaseModel):
    overall_status: str
    affirmation_findings: List[Dict[str, Any]]
    historical_conflicts_cited: List[Dict[str, Any]]
    evaluated_against_event_count: int
    doctor_action_required: bool = False
