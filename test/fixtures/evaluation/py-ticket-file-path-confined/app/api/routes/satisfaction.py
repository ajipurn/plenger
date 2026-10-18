from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import require
from app.core.db import get_session
from app.core.pagination import Page, page_params
from app.core.security import Principal
from app.schemas.common import Listing
from app.schemas.satisfaction import RatingOut, SatisfactionSummary
from app.services.satisfaction import SatisfactionService

router = APIRouter(prefix="/satisfaction", tags=["satisfaction"])


@router.get("/ratings", response_model=Listing[RatingOut])
def list_ratings(
    page: Page = Depends(page_params),
    principal: Principal = Depends(require("satisfaction:read")),
    session: Session = Depends(get_session),
):
    ratings, total = SatisfactionService(session, principal).list(page)
    return Listing(items=ratings, total=total, limit=page.limit, offset=page.offset)


@router.get("/summary", response_model=SatisfactionSummary)
def rating_summary(
    assignee_id: int | None = Query(None),
    principal: Principal = Depends(require("satisfaction:read")),
    session: Session = Depends(get_session),
):
    return SatisfactionService(session, principal).summary(assignee_id)
