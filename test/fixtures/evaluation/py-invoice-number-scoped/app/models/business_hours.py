from sqlalchemy import JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import OrgScoped, Timestamped


class BusinessHours(OrgScoped, Timestamped, Base):
    __tablename__ = "business_hours"

    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    # Weekday (0 is Monday) to a list of [start, end] minutes after midnight.
    schedule: Mapped[dict[str, list[list[int]]]] = mapped_column(JSON, default=dict)
    holidays: Mapped[list[str]] = mapped_column(JSON, default=list)
