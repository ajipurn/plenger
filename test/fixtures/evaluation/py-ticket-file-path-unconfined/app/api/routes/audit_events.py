from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import require
from app.core.db import get_session
from app.core.pagination import Page, page_params
from app.core.security import Principal
from app.schemas.audit_event import AuditEventOut
from app.schemas.common import Listing
from app.services.audit_events import AuditService

router = APIRouter(prefix="/audit-events", tags=["audit"])


@router.get("", response_model=Listing[AuditEventOut])
def list_audit_events(
    since: datetime | None = Query(None),
    actor_id: int | None = Query(None),
    page: Page = Depends(page_params),
    principal: Principal = Depends(require("audit:read")),
    session: Session = Depends(get_session),
):
    events, total = AuditService(session, principal).history(since, actor_id, page)
    return Listing(items=events, total=total, limit=page.limit, offset=page.offset)
