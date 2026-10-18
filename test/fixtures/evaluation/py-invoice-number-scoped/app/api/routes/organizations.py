from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import require
from app.core.db import get_session
from app.core.security import Principal
from app.schemas.organization import OrganizationOut, OrganizationUpdate
from app.services.organizations import OrganizationService

router = APIRouter(prefix="/organization", tags=["organization"])


@router.get("", response_model=OrganizationOut)
def get_organization(
    principal: Principal = Depends(require("org:read")),
    session: Session = Depends(get_session),
):
    return OrganizationService(session, principal).current()


@router.patch("", response_model=OrganizationOut)
def update_organization(
    change: OrganizationUpdate,
    principal: Principal = Depends(require("org:manage")),
    session: Session = Depends(get_session),
):
    return OrganizationService(session, principal).update(change)
