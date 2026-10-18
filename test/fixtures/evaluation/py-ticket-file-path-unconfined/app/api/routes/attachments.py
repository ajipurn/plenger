from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.api.deps import require
from app.core.db import get_session
from app.core.errors import NotFound
from app.core.security import Principal
from app.schemas.attachment import AttachmentOut
from app.services.attachments import AttachmentService
from app.services.tickets import TicketService
from app.utils.files.media import media_type
from app.utils.files.paths import ticket_file_path

router = APIRouter(prefix="/tickets/{ticket_id}", tags=["attachments"])


@router.get("/attachments", response_model=list[AttachmentOut])
def list_attachments(
    ticket_id: int,
    principal: Principal = Depends(require("tickets:read")),
    session: Session = Depends(get_session),
):
    return AttachmentService(session, principal).for_ticket(ticket_id)


@router.get("/files/{filename:path}")
def download_ticket_file(
    ticket_id: int,
    filename: str,
    principal: Principal = Depends(require("tickets:read")),
    session: Session = Depends(get_session),
):
    ticket = TicketService(session, principal).get(ticket_id)
    path = ticket_file_path(ticket.id, filename)
    try:
        with open(path, "rb") as handle:
            content = handle.read()
    except (FileNotFoundError, IsADirectoryError, ValueError):
        raise NotFound("file") from None
    return Response(content, media_type=media_type(filename))
