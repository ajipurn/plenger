from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.core.errors import Invalid, NotFound
from app.core.pagination import Page
from app.core.security import Principal
from app.models.invoice import Invoice
from app.repositories.invoices import InvoiceRepository
from app.services.audit_events import AuditService


class InvoiceService:
    def __init__(self, session: Session, principal: Principal):
        self.invoices = InvoiceRepository(session, principal.org_id)
        self.audit = AuditService(session, principal)

    def list(self, customer_id: int | None, page: Page) -> tuple[list[Invoice], int]:
        if customer_id is not None:
            return self.invoices.for_customer(customer_id, page)
        return self.invoices.list(page)

    def by_number(self, number: str) -> Invoice:
        invoice = self.invoices.by_number(number.strip().upper())
        if invoice is None:
            raise NotFound("invoice")
        return invoice

    def void(self, invoice_id: int) -> Invoice:
        invoice = self.invoices.get(invoice_id)
        if invoice is None:
            raise NotFound("invoice")
        if invoice.status != "open":
            raise Invalid("only open invoices can be voided")
        invoice.status = "void"
        invoice.voided_at = utcnow()
        self.audit.record("invoice.voided", "invoice", invoice.id)
        return invoice
