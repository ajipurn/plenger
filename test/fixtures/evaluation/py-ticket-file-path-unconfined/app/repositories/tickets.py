from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.core.pagination import Page
from app.models.tag import Tag
from app.models.ticket import Ticket
from app.repositories.base import OrgRepository
from app.schemas.ticket import TicketFilter


class TicketRepository(OrgRepository[Ticket]):
    model = Ticket

    def get(self, row_id: int) -> Ticket | None:
        query = self.scoped().options(selectinload(Ticket.tags)).where(Ticket.id == row_id)
        return self.session.scalars(query).first()

    def filtered(self, criteria: TicketFilter, page: Page) -> tuple[list[Ticket], int]:
        query = self.scoped().options(selectinload(Ticket.tags))
        if criteria.status:
            query = query.where(Ticket.status == criteria.status)
        if criteria.priority:
            query = query.where(Ticket.priority == criteria.priority)
        if criteria.assignee_id is not None:
            query = query.where(Ticket.assignee_id == criteria.assignee_id)
        if criteria.customer_id is not None:
            query = query.where(Ticket.customer_id == criteria.customer_id)
        if criteria.tag:
            query = query.where(Ticket.tags.any(Tag.name == criteria.tag))
        return self.page(query, page)

    def next_number(self) -> int:
        query = select(func.max(Ticket.number)).where(Ticket.org_id == self.org_id)
        return (self.session.scalar(query) or 0) + 1
