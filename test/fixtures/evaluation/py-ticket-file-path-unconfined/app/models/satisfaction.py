from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import OrgScoped, Timestamped


class SatisfactionRating(OrgScoped, Timestamped, Base):
    __tablename__ = "satisfaction_ratings"

    ticket_id: Mapped[int] = mapped_column(ForeignKey("tickets.id"), unique=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"))
    assignee_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    score: Mapped[int] = mapped_column(Integer)
    comment: Mapped[str] = mapped_column(String(1000), default="")
