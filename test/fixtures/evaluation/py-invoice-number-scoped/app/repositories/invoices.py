from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.core.pagination import Page
from app.models.invoice import Invoice
from app.repositories.base import OrgRepository


class InvoiceRepository(OrgRepository[Invoice]):
    model = Invoice

    def by_number(self, number: str) -> Invoice | None:
        query = self.scoped().options(selectinload(Invoice.lines)).where(Invoice.number == number)
        return self.session.scalars(query).first()

    def for_customer(self, customer_id: int, page: Page) -> tuple[list[Invoice], int]:
        query = self.scoped().where(Invoice.customer_id == customer_id)
        return self.page(query, page)

    def overdue_count(self) -> int:
        query = select(func.count()).where(
            Invoice.org_id == self.org_id,
            Invoice.status == "open",
            Invoice.due_on < func.current_date(),
        )
        return self.session.scalar(query) or 0
