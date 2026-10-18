from sqlalchemy.orm import Session

from app.core.errors import Conflict, Invalid, NotFound
from app.core.pagination import Page
from app.core.security import Principal
from app.models.user import User
from app.repositories.users import UserRepository
from app.schemas.user import UserCreate
from app.services.audit_events import AuditService


class UserService:
    def __init__(self, session: Session, principal: Principal):
        self.principal = principal
        self.users = UserRepository(session, principal.org_id)
        self.audit = AuditService(session, principal)

    def get(self, user_id: int) -> User:
        user = self.users.get(user_id)
        if user is None:
            raise NotFound("user")
        return user

    def list(self, page: Page) -> tuple[list[User], int]:
        return self.users.list(page)

    def create(self, data: UserCreate) -> User:
        if self.users.by_email(data.email) is not None:
            raise Conflict("a user with this email exists")
        user = self.users.add(User(email=data.email.lower(), name=data.name, role=data.role))
        self.audit.record("user.created", "user", user.id, role=data.role)
        return user

    def change_role(self, user_id: int, role: str) -> User:
        user = self.get(user_id)
        if user.role == "owner":
            raise Invalid("the owner's role cannot change")
        if user.id == self.principal.user_id:
            raise Invalid("you cannot change your own role")
        self.audit.record("user.role_changed", "user", user.id, before=user.role, after=role)
        user.role = role
        return user

    def deactivate(self, user_id: int) -> User:
        user = self.get(user_id)
        if user.role == "owner" or user.id == self.principal.user_id:
            raise Invalid("this user cannot be deactivated")
        user.active = False
        self.audit.record("user.deactivated", "user", user.id)
        return user
