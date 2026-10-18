from sqlalchemy.orm import Session

from app.core.clock import utcnow
from app.core.pagination import Page
from app.core.security import Principal
from app.models.comment import Comment
from app.repositories.comments import CommentRepository
from app.schemas.comment import CommentCreate
from app.services.tickets import TicketService


class CommentService:
    def __init__(self, session: Session, principal: Principal):
        self.principal = principal
        self.comments = CommentRepository(session, principal.org_id)
        self.tickets = TicketService(session, principal)

    def list(self, ticket_id: int, page: Page) -> tuple[list[Comment], int]:
        ticket = self.tickets.get(ticket_id)
        public_only = not self.principal.can("comments:write")
        return self.comments.for_ticket(ticket.id, page, public_only=public_only)

    def add(self, ticket_id: int, data: CommentCreate) -> Comment:
        ticket = self.tickets.get(ticket_id)
        comment = self.comments.add(
            Comment(
                ticket_id=ticket.id,
                author_id=self.principal.user_id,
                body=data.body,
                public=data.public,
            )
        )
        if data.public and ticket.first_response_due is not None:
            ticket.first_response_due = None
        ticket.updated_at = utcnow()
        return comment
