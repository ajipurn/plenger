from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, ForeignKey, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base
from app.models.base import OrgScoped, Timestamped


class InvoiceLine(Base):
    __tablename__ = "invoice_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    invoice_id: Mapped[int] = mapped_column(ForeignKey("invoices.id"), index=True)
    description: Mapped[str] = mapped_column(String(200))
    quantity: Mapped[Decimal] = mapped_column(Numeric(10, 2))
    unit_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))


class Invoice(OrgScoped, Timestamped, Base):
    __tablename__ = "invoices"
    __table_args__ = (UniqueConstraint("org_id", "number"),)

    number: Mapped[str] = mapped_column(String(16))
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True)
    currency: Mapped[str] = mapped_column(String(3), default="USD")
    status: Mapped[str] = mapped_column(String(16), default="open")
    issued_on: Mapped[date] = mapped_column(Date)
    due_on: Mapped[date] = mapped_column(Date)
    voided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    billing_address: Mapped[str] = mapped_column(String(500), default="")
    lines: Mapped[list[InvoiceLine]] = relationship(cascade="all, delete-orphan")

    @property
    def total(self) -> Decimal:
        return sum((line.quantity * line.unit_price for line in self.lines), Decimal("0"))
