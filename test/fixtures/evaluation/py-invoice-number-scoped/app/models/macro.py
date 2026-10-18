from sqlalchemy import JSON, Boolean, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import OrgScoped, Timestamped


class Macro(OrgScoped, Timestamped, Base):
    __tablename__ = "macros"

    title: Mapped[str] = mapped_column(String(120))
    reply: Mapped[str] = mapped_column(Text, default="")
    set_status: Mapped[str | None] = mapped_column(String(16))
    set_priority: Mapped[str | None] = mapped_column(String(16))
    add_tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
