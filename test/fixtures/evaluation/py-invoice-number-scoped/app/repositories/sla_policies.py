from app.models.sla_policy import SlaPolicy
from app.repositories.base import OrgRepository


class SlaPolicyRepository(OrgRepository[SlaPolicy]):
    model = SlaPolicy

    def for_priority(self, priority: str) -> SlaPolicy | None:
        query = self.scoped().where(SlaPolicy.priority == priority)
        return self.session.scalars(query.order_by(SlaPolicy.id)).first()
