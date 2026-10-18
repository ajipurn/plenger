from datetime import datetime

from app.core.pagination import Page
from app.models.audit_event import AuditEvent
from app.repositories.base import OrgRepository


class AuditEventRepository(OrgRepository[AuditEvent]):
    model = AuditEvent

    def since(
        self, start: datetime | None, actor_id: int | None, page: Page
    ) -> tuple[list[AuditEvent], int]:
        query = self.scoped()
        if start is not None:
            query = query.where(AuditEvent.created_at >= start)
        if actor_id is not None:
            query = query.where(AuditEvent.actor_id == actor_id)
        return self.page(query, page)
