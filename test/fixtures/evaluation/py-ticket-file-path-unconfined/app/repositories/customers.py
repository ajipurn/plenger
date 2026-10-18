from sqlalchemy import or_

from app.core.pagination import Page
from app.models.customer import Customer
from app.repositories.base import OrgRepository


class CustomerRepository(OrgRepository[Customer]):
    model = Customer

    def by_email(self, email: str) -> Customer | None:
        query = self.scoped().where(Customer.email == email.lower())
        return self.session.scalars(query).first()

    def search(self, text: str, page: Page) -> tuple[list[Customer], int]:
        pattern = f"%{text.strip()}%"
        query = self.scoped().where(
            or_(
                Customer.name.ilike(pattern),
                Customer.email.ilike(pattern),
                Customer.company.ilike(pattern),
            )
        )
        return self.page(query, page)
