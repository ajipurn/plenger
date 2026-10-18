from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.api.deps import require
from app.api.routes.tickets import ticket_out
from app.core.db import get_session
from app.core.security import Principal
from app.schemas.tag import TagCreate, TagOut, TicketTags
from app.schemas.ticket import TicketOut
from app.services.tags import TagService

router = APIRouter(tags=["tags"])


@router.get("/tags", response_model=list[TagOut])
def list_tags(
    principal: Principal = Depends(require("tags:read")),
    session: Session = Depends(get_session),
):
    return TagService(session, principal).all()


@router.post("/tags", response_model=TagOut, status_code=status.HTTP_201_CREATED)
def create_tag(
    data: TagCreate,
    principal: Principal = Depends(require("tags:write")),
    session: Session = Depends(get_session),
):
    return TagService(session, principal).create(data)


@router.put("/tickets/{ticket_id}/tags", response_model=TicketOut)
def set_ticket_tags(
    ticket_id: int,
    data: TicketTags,
    principal: Principal = Depends(require("tags:write")),
    session: Session = Depends(get_session),
):
    return ticket_out(TagService(session, principal).set_for_ticket(ticket_id, data.names))
