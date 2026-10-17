from dataclasses import dataclass

from fastapi import Header


@dataclass
class User:
    id: str
    tenant_id: str


def current_user(authorization: str = Header()) -> User:
    """Resolve the signed session token to its user."""
    raise NotImplementedError
