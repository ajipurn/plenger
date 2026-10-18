from datetime import datetime

from sqlalchemy.orm import Session

from app.core.pagination import Page
from app.core.security import Principal
from app.models.audit_event import AuditEvent
from app.repositories.audit_events import AuditEventRepository


class AuditService:
    def __init__(self, session: Session, principal: Principal):
        self.principal = principal
        self.events = AuditEventRepository(session, principal.org_id)

    def record(self, action: str, target_type: str, target_id: int, **changes: object) -> None:
        self.events.add(
            AuditEvent(
                actor_id=self.principal.user_id,
                action=action,
                target_type=target_type,
                target_id=target_id,
                changes=changes,
            )
        )

    def history(
        self, start: datetime | None, actor_id: int | None, page: Page
    ) -> tuple[list[AuditEvent], int]:
        return self.events.since(start, actor_id, page)
