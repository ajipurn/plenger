from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.api.deps import require
from app.core.db import get_session
from app.core.pagination import Page, page_params
from app.core.security import Principal
from app.schemas.comment import CommentCreate, CommentOut
from app.schemas.common import Listing
from app.services.comments import CommentService

router = APIRouter(prefix="/tickets/{ticket_id}/comments", tags=["comments"])


@router.get("", response_model=Listing[CommentOut])
def list_comments(
    ticket_id: int,
    page: Page = Depends(page_params),
    principal: Principal = Depends(require("comments:read")),
    session: Session = Depends(get_session),
):
    comments, total = CommentService(session, principal).list(ticket_id, page)
    return Listing(items=comments, total=total, limit=page.limit, offset=page.offset)


@router.post("", response_model=CommentOut, status_code=status.HTTP_201_CREATED)
def add_comment(
    ticket_id: int,
    data: CommentCreate,
    principal: Principal = Depends(require("comments:write")),
    session: Session = Depends(get_session),
):
    return CommentService(session, principal).add(ticket_id, data)
