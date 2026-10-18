from sqlalchemy import Boolean, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import OrgScoped, Timestamped


class User(OrgScoped, Timestamped, Base):
    __tablename__ = "users"
    __table_args__ = (UniqueConstraint("org_id", "email"),)

    email: Mapped[str] = mapped_column(String(254))
    name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(16), default="agent")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    signature: Mapped[str] = mapped_column(String(500), default="")
