from sqlalchemy.orm import Session

from app.core.errors import Conflict, Invalid
from app.core.security import Principal
from app.models.tag import Tag
from app.models.ticket import Ticket
from app.repositories.tags import TagRepository
from app.schemas.tag import TagCreate
from app.services.tickets import TicketService


class TagService:
    def __init__(self, session: Session, principal: Principal):
        self.tags = TagRepository(session, principal.org_id)
        self.tickets = TicketService(session, principal)

    def all(self) -> list[Tag]:
        return self.tags.all()

    def create(self, data: TagCreate) -> Tag:
        if self.tags.named([data.name]):
            raise Conflict("a tag with this name exists")
        return self.tags.add(Tag(name=data.name, color=data.color))

    def set_for_ticket(self, ticket_id: int, names: list[str]) -> Ticket:
        ticket = self.tickets.get(ticket_id)
        wanted = sorted(set(names))
        tags = self.tags.named(wanted)
        if len(tags) != len(wanted):
            raise Invalid("unknown tag")
        ticket.tags = tags
        return ticket
