from sqlalchemy.orm import Session

from app.core.security import Principal
from app.models.attachment import Attachment
from app.repositories.attachments import AttachmentRepository
from app.services.tickets import TicketService


class AttachmentService:
    def __init__(self, session: Session, principal: Principal):
        self.attachments = AttachmentRepository(session, principal.org_id)
        self.tickets = TicketService(session, principal)

    def for_ticket(self, ticket_id: int) -> list[Attachment]:
        ticket = self.tickets.get(ticket_id)
        return self.attachments.for_ticket(ticket.id)
