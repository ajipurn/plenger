from sqlalchemy.orm import Session

from app.core.errors import NotFound
from app.core.security import Principal
from app.models.organization import Organization
from app.repositories.organizations import OrganizationRepository
from app.schemas.organization import OrganizationUpdate
from app.services.audit_events import AuditService


class OrganizationService:
    def __init__(self, session: Session, principal: Principal):
        self.organizations = OrganizationRepository(session, principal.org_id)
        self.audit = AuditService(session, principal)

    def current(self) -> Organization:
        organization = self.organizations.current()
        if organization is None:
            raise NotFound("organization")
        return organization

    def update(self, change: OrganizationUpdate) -> Organization:
        organization = self.current()
        fields = change.model_dump(exclude_unset=True)
        for name, value in fields.items():
            setattr(organization, name, value)
        self.audit.record("organization.updated", "organization", organization.id, **fields)
        return organization
