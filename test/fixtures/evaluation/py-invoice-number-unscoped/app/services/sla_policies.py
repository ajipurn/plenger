from sqlalchemy.orm import Session

from app.core.errors import Conflict, NotFound
from app.core.pagination import Page
from app.core.security import Principal
from app.models.sla_policy import SlaPolicy
from app.repositories.sla_policies import SlaPolicyRepository
from app.schemas.sla_policy import SlaPolicyCreate, SlaPolicyUpdate
from app.services.audit_events import AuditService


class SlaPolicyService:
    def __init__(self, session: Session, principal: Principal):
        self.policies = SlaPolicyRepository(session, principal.org_id)
        self.audit = AuditService(session, principal)

    def list(self, page: Page) -> tuple[list[SlaPolicy], int]:
        return self.policies.list(page)

    def create(self, data: SlaPolicyCreate) -> SlaPolicy:
        if self.policies.for_priority(data.priority) is not None:
            raise Conflict("a policy for this priority exists")
        policy = self.policies.add(SlaPolicy(**data.model_dump()))
        self.audit.record("sla_policy.created", "sla_policy", policy.id)
        return policy

    def update(self, policy_id: int, change: SlaPolicyUpdate) -> SlaPolicy:
        policy = self.policies.get(policy_id)
        if policy is None:
            raise NotFound("SLA policy")
        fields = change.model_dump(exclude_unset=True)
        for name, value in fields.items():
            setattr(policy, name, value)
        self.audit.record("sla_policy.updated", "sla_policy", policy.id, **fields)
        return policy
