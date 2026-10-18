from sqlalchemy.orm import Session

from app.models.organization import Organization


class OrganizationRepository:
    def __init__(self, session: Session, org_id: int):
        self.session = session
        self.org_id = org_id

    def current(self) -> Organization | None:
        return self.session.get(Organization, self.org_id)
