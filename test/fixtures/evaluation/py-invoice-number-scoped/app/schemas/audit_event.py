from app.schemas.common import Record


class AuditEventOut(Record):
    actor_id: int
    action: str
    target_type: str
    target_id: int
    changes: dict[str, object]
