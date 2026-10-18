from datetime import date
from decimal import Decimal

from pydantic import BaseModel, ConfigDict

from app.schemas.common import Record


class InvoiceLineOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    description: str
    quantity: Decimal
    unit_price: Decimal


class InvoiceOut(Record):
    number: str
    customer_id: int
    currency: str
    status: str
    issued_on: date
    due_on: date
    billing_address: str
    total: Decimal
    lines: list[InvoiceLineOut]


class InvoiceSummary(Record):
    number: str
    customer_id: int
    status: str
    due_on: date
