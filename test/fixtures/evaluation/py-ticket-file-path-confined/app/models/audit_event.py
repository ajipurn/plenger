from sqlalchemy import JSON, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import OrgScoped, Timestamped


class AuditEvent(OrgScoped, Timestamped, Base):
    __tablename__ = "audit_events"

    actor_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(64))
    target_type: Mapped[str] = mapped_column(String(32))
    target_id: Mapped[int] = mapped_column()
    changes: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
