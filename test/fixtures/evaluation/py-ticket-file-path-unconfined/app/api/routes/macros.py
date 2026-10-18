from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.api.deps import require
from app.api.routes.tickets import ticket_out
from app.core.db import get_session
from app.core.security import Principal
from app.schemas.macro import MacroCreate, MacroOut
from app.schemas.ticket import TicketOut
from app.services.macros import MacroService

router = APIRouter(tags=["macros"])


@router.get("/macros", response_model=list[MacroOut])
def list_macros(
    principal: Principal = Depends(require("macros:read")),
    session: Session = Depends(get_session),
):
    return MacroService(session, principal).active()


@router.post("/macros", response_model=MacroOut, status_code=status.HTTP_201_CREATED)
def create_macro(
    data: MacroCreate,
    principal: Principal = Depends(require("macros:manage")),
    session: Session = Depends(get_session),
):
    return MacroService(session, principal).create(data)


@router.post("/tickets/{ticket_id}/macros/{macro_id}", response_model=TicketOut)
def apply_macro(
    ticket_id: int,
    macro_id: int,
    principal: Principal = Depends(require("macros:apply")),
    session: Session = Depends(get_session),
):
    return ticket_out(MacroService(session, principal).apply(ticket_id, macro_id))
