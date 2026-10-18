from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base
from app.models.base import OrgScoped, Timestamped
from app.models.tag import Tag, ticket_tags

STATUSES = ("new", "open", "pending", "on_hold", "solved", "closed")
PRIORITIES = ("low", "normal", "high", "urgent")


class Ticket(OrgScoped, Timestamped, Base):
    __tablename__ = "tickets"
    __table_args__ = (UniqueConstraint("org_id", "number"),)

    number: Mapped[int] = mapped_column(Integer)
    subject: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(16), default="new")
    priority: Mapped[str] = mapped_column(String(16), default="normal")
    channel: Mapped[str] = mapped_column(String(16), default="email")
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"))
    assignee_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    team_id: Mapped[int | None] = mapped_column(ForeignKey("teams.id"))
    sla_policy_id: Mapped[int | None] = mapped_column(ForeignKey("sla_policies.id"))
    first_response_due: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    solved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    tags: Mapped[list[Tag]] = relationship(secondary=ticket_tags)
