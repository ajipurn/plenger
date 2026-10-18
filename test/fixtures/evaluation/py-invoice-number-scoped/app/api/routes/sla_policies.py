from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.api.deps import require
from app.core.db import get_session
from app.core.pagination import Page, page_params
from app.core.security import Principal
from app.schemas.common import Listing
from app.schemas.sla_policy import SlaPolicyCreate, SlaPolicyOut, SlaPolicyUpdate
from app.services.sla_policies import SlaPolicyService

router = APIRouter(prefix="/sla-policies", tags=["sla"])


@router.get("", response_model=Listing[SlaPolicyOut])
def list_policies(
    page: Page = Depends(page_params),
    principal: Principal = Depends(require("sla:read")),
    session: Session = Depends(get_session),
):
    policies, total = SlaPolicyService(session, principal).list(page)
    return Listing(items=policies, total=total, limit=page.limit, offset=page.offset)


@router.post("", response_model=SlaPolicyOut, status_code=status.HTTP_201_CREATED)
def create_policy(
    data: SlaPolicyCreate,
    principal: Principal = Depends(require("sla:manage")),
    session: Session = Depends(get_session),
):
    return SlaPolicyService(session, principal).create(data)


@router.patch("/{policy_id}", response_model=SlaPolicyOut)
def update_policy(
    policy_id: int,
    change: SlaPolicyUpdate,
    principal: Principal = Depends(require("sla:manage")),
    session: Session = Depends(get_session),
):
    return SlaPolicyService(session, principal).update(policy_id, change)
