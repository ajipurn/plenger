from sqlalchemy.orm import Session

from app.core.errors import Conflict, NotFound
from app.core.pagination import Page
from app.core.security import Principal
from app.models.customer import Customer
from app.repositories.customers import CustomerRepository
from app.schemas.customer import CustomerCreate, CustomerUpdate


class CustomerService:
    def __init__(self, session: Session, principal: Principal):
        self.customers = CustomerRepository(session, principal.org_id)

    def get(self, customer_id: int) -> Customer:
        customer = self.customers.get(customer_id)
        if customer is None:
            raise NotFound("customer")
        return customer

    def list(self, query: str | None, page: Page) -> tuple[list[Customer], int]:
        if query:
            return self.customers.search(query, page)
        return self.customers.list(page)

    def create(self, data: CustomerCreate) -> Customer:
        if self.customers.by_email(data.email) is not None:
            raise Conflict("a customer with this email exists")
        return self.customers.add(
            Customer(
                email=data.email.lower(),
                name=data.name,
                company=data.company,
                phone=data.phone,
            )
        )

    def update(self, customer_id: int, change: CustomerUpdate) -> Customer:
        customer = self.get(customer_id)
        for name, value in change.model_dump(exclude_unset=True).items():
            setattr(customer, name, value)
        return customer
