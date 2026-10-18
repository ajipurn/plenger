from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, status
from itsdangerous import BadSignature, URLSafeTimedSerializer
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import get_session
from app.models.user import User

_VIEWER = frozenset(
    {
        "org:read",
        "users:read",
        "teams:read",
        "customers:read",
        "tickets:read",
        "comments:read",
        "tags:read",
        "macros:read",
        "sla:read",
        "hours:read",
        "satisfaction:read",
    }
)
_AGENT = _VIEWER | {
    "customers:write",
    "tickets:write",
    "comments:write",
    "tags:write",
    "macros:apply",
}
_ADMIN = _AGENT | {
    "org:manage",
    "users:manage",
    "teams:manage",
    "macros:manage",
    "sla:manage",
    "hours:manage",
    "audit:read",
    "billing:read",
    "billing:manage",
}
ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    "viewer": _VIEWER,
    "agent": frozenset(_AGENT),
    "admin": frozenset(_ADMIN),
    "owner": frozenset({"*"}),
}
ROLES = tuple(ROLE_PERMISSIONS)

_serializer = URLSafeTimedSerializer(settings.session_secret, salt="deskline-session")


@dataclass(frozen=True)
class Principal:
    user_id: int
    org_id: int
    role: str

    def can(self, permission: str) -> bool:
        granted = ROLE_PERMISSIONS.get(self.role, frozenset())
        return "*" in granted or permission in granted


def issue_token(user: User) -> str:
    return _serializer.dumps({"uid": user.id})


def current_principal(
    authorization: str = Header(),
    session: Session = Depends(get_session),
) -> Principal:
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bearer token required")
    try:
        claims = _serializer.loads(token, max_age=settings.session_max_age)
    except BadSignature:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid session") from None
    user = session.get(User, claims.get("uid"))
    if user is None or not user.active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid session")
    return Principal(user_id=user.id, org_id=user.org_id, role=user.role)
