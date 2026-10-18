from collections.abc import Callable

from fastapi import Depends

from app.core.errors import Forbidden
from app.core.security import Principal, current_principal


def require(permission: str) -> Callable[..., Principal]:
    """A dependency that resolves the caller and checks one permission."""

    def dependency(principal: Principal = Depends(current_principal)) -> Principal:
        if not principal.can(permission):
            raise Forbidden(permission)
        return principal

    return dependency
