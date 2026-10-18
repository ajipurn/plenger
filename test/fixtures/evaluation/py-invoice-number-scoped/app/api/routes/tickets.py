from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.api.deps import require
from app.core.db import get_session
from app.core.pagination import Page, page_params
from app.core.security import Principal
from app.models.ticket import Ticket
from app.schemas.common import Listing
from app.schemas.ticket import Assignment, TicketCreate, TicketFilter, TicketOut, TicketUpdate
from app.services.tickets import TicketService

router = APIRouter(prefix="/tickets", tags=["tickets"])


def ticket_out(ticket: Ticket) -> TicketOut:
    return TicketOut.model_validate(
        {
            **{column: getattr(ticket, column) for column in TicketOut.model_fields if column != "tags"},
            "tags": [tag.name for tag in ticket.tags],
        }
    )


@router.get("", response_model=Listing[TicketOut])
def list_tickets(
    criteria: TicketFilter = Depends(),
    page: Page = Depends(page_params),
    principal: Principal = Depends(require("tickets:read")),
    session: Session = Depends(get_session),
):
    tickets, total = TicketService(session, principal).search(criteria, page)
    items = [ticket_out(ticket) for ticket in tickets]
    return Listing(items=items, total=total, limit=page.limit, offset=page.offset)


@router.get("/{ticket_id}", response_model=TicketOut)
def get_ticket(
    ticket_id: int,
    principal: Principal = Depends(require("tickets:read")),
    session: Session = Depends(get_session),
):
    return ticket_out(TicketService(session, principal).get(ticket_id))


@router.post("", response_model=TicketOut, status_code=status.HTTP_201_CREATED)
def open_ticket(
    data: TicketCreate,
    principal: Principal = Depends(require("tickets:write")),
    session: Session = Depends(get_session),
):
    return ticket_out(TicketService(session, principal).open(data))


@router.patch("/{ticket_id}", response_model=TicketOut)
def update_ticket(
    ticket_id: int,
    change: TicketUpdate,
    principal: Principal = Depends(require("tickets:write")),
    session: Session = Depends(get_session),
):
    return ticket_out(TicketService(session, principal).update(ticket_id, change))


@router.put("/{ticket_id}/assignee", response_model=TicketOut)
def assign_ticket(
    ticket_id: int,
    assignment: Assignment,
    principal: Principal = Depends(require("tickets:write")),
    session: Session = Depends(get_session),
):
    service = TicketService(session, principal)
    return ticket_out(service.assign(ticket_id, assignment.assignee_id))
