from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import require
from app.core.db import get_session
from app.core.security import Principal
from app.schemas.business_hours import BusinessHoursOut, BusinessHoursUpdate
from app.services.business_hours import BusinessHoursService

router = APIRouter(prefix="/business-hours", tags=["sla"])


@router.get("", response_model=BusinessHoursOut)
def get_business_hours(
    principal: Principal = Depends(require("hours:read")),
    session: Session = Depends(get_session),
):
    return BusinessHoursService(session, principal).current()


@router.put("", response_model=BusinessHoursOut)
def replace_business_hours(
    data: BusinessHoursUpdate,
    principal: Principal = Depends(require("hours:manage")),
    session: Session = Depends(get_session),
):
    return BusinessHoursService(session, principal).replace(data)
