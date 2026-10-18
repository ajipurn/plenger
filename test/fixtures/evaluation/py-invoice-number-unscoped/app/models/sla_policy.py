from sqlalchemy import Boolean, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import OrgScoped, Timestamped


class SlaPolicy(OrgScoped, Timestamped, Base):
    __tablename__ = "sla_policies"

    name: Mapped[str] = mapped_column(String(80))
    priority: Mapped[str] = mapped_column(String(16))
    first_response_minutes: Mapped[int] = mapped_column(Integer)
    resolution_minutes: Mapped[int] = mapped_column(Integer)
    business_hours_only: Mapped[bool] = mapped_column(Boolean, default=True)
