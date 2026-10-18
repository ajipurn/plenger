from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.api.deps import require
from app.core.db import get_session
from app.core.pagination import Page, page_params
from app.core.security import Principal
from app.schemas.common import Listing
from app.schemas.user import RoleChange, UserCreate, UserOut
from app.services.users import UserService

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=Listing[UserOut])
def list_users(
    page: Page = Depends(page_params),
    principal: Principal = Depends(require("users:read")),
    session: Session = Depends(get_session),
):
    users, total = UserService(session, principal).list(page)
    return Listing(items=users, total=total, limit=page.limit, offset=page.offset)


@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(
    data: UserCreate,
    principal: Principal = Depends(require("users:manage")),
    session: Session = Depends(get_session),
):
    return UserService(session, principal).create(data)


@router.put("/{user_id}/role", response_model=UserOut)
def change_role(
    user_id: int,
    change: RoleChange,
    principal: Principal = Depends(require("users:manage")),
    session: Session = Depends(get_session),
):
    return UserService(session, principal).change_role(user_id, change.role)


@router.post("/{user_id}/deactivate", response_model=UserOut)
def deactivate_user(
    user_id: int,
    principal: Principal = Depends(require("users:manage")),
    session: Session = Depends(get_session),
):
    return UserService(session, principal).deactivate(user_id)
