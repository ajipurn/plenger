from sqlalchemy.orm import Session

from app.core.clock import minutes_from, utcnow
from app.core.config import settings
from app.core.errors import Invalid, NotFound
from app.core.pagination import Page
from app.core.security import Principal
from app.models.comment import Comment
from app.models.ticket import Ticket
from app.repositories.comments import CommentRepository
from app.repositories.customers import CustomerRepository
from app.repositories.sla_policies import SlaPolicyRepository
from app.repositories.teams import TeamRepository
from app.repositories.tickets import TicketRepository
from app.repositories.users import UserRepository
from app.schemas.ticket import TicketCreate, TicketFilter, TicketUpdate
from app.services.audit_events import AuditService


class TicketService:
    def __init__(self, session: Session, principal: Principal):
        self.principal = principal
        self.tickets = TicketRepository(session, principal.org_id)
        self.comments = CommentRepository(session, principal.org_id)
        self.customers = CustomerRepository(session, principal.org_id)
        self.policies = SlaPolicyRepository(session, principal.org_id)
        self.teams = TeamRepository(session, principal.org_id)
        self.users = UserRepository(session, principal.org_id)
        self.audit = AuditService(session, principal)

    def get(self, ticket_id: int) -> Ticket:
        ticket = self.tickets.get(ticket_id)
        if ticket is None:
            raise NotFound("ticket")
        return ticket

    def search(self, criteria: TicketFilter, page: Page) -> tuple[list[Ticket], int]:
        return self.tickets.filtered(criteria, page)

    def open(self, data: TicketCreate) -> Ticket:
        if self.customers.get(data.customer_id) is None:
            raise Invalid("unknown customer")
        policy = self.policies.for_priority(data.priority)
        minutes = policy.first_response_minutes if policy else settings.first_response_minutes
        ticket = self.tickets.add(
            Ticket(
                number=self.tickets.next_number(),
                subject=data.subject,
                priority=data.priority,
                channel=data.channel,
                customer_id=data.customer_id,
                sla_policy_id=policy.id if policy else None,
                first_response_due=minutes_from(utcnow(), minutes),
            )
        )
        self.comments.add(
            Comment(ticket_id=ticket.id, customer_id=data.customer_id, body=data.body)
        )
        return ticket

    def update(self, ticket_id: int, change: TicketUpdate) -> Ticket:
        ticket = self.get(ticket_id)
        fields = change.model_dump(exclude_unset=True)
        if fields.get("team_id") is not None and self.teams.get(fields["team_id"]) is None:
            raise Invalid("unknown team")
        for name, value in fields.items():
            setattr(ticket, name, value)
        if fields.get("status") == "solved":
            ticket.solved_at = utcnow()
        self.audit.record("ticket.updated", "ticket", ticket.id, **fields)
        return ticket

    def assign(self, ticket_id: int, assignee_id: int | None) -> Ticket:
        ticket = self.get(ticket_id)
        if assignee_id is not None and not self.users.active([assignee_id]):
            raise Invalid("the assignee must be an active user")
        ticket.assignee_id = assignee_id
        if ticket.status == "new":
            ticket.status = "open"
        self.audit.record("ticket.assigned", "ticket", ticket.id, assignee_id=assignee_id)
        return ticket
