from sqlalchemy.orm import Session

from app.core.errors import Invalid, NotFound
from app.core.security import Principal
from app.models.macro import Macro
from app.models.ticket import Ticket
from app.repositories.macros import MacroRepository
from app.repositories.tags import TagRepository
from app.schemas.comment import CommentCreate
from app.schemas.macro import MacroCreate
from app.services.comments import CommentService
from app.services.tickets import TicketService


class MacroService:
    def __init__(self, session: Session, principal: Principal):
        self.macros = MacroRepository(session, principal.org_id)
        self.tags = TagRepository(session, principal.org_id)
        self.tickets = TicketService(session, principal)
        self.comments = CommentService(session, principal)

    def active(self) -> list[Macro]:
        return self.macros.active()

    def create(self, data: MacroCreate) -> Macro:
        if data.add_tags and len(self.tags.named(data.add_tags)) != len(set(data.add_tags)):
            raise Invalid("unknown tag")
        return self.macros.add(Macro(**data.model_dump()))

    def apply(self, ticket_id: int, macro_id: int) -> Ticket:
        macro = self.macros.get(macro_id)
        if macro is None or not macro.active:
            raise NotFound("macro")
        ticket = self.tickets.get(ticket_id)
        if macro.set_status:
            ticket.status = macro.set_status
        if macro.set_priority:
            ticket.priority = macro.set_priority
        if macro.add_tags:
            known = {tag.name for tag in ticket.tags}
            ticket.tags.extend(
                tag for tag in self.tags.named(macro.add_tags) if tag.name not in known
            )
        if macro.reply:
            self.comments.add(ticket.id, CommentCreate(body=macro.reply, public=True))
        return ticket
