from app.models.user import User
from app.repositories.base import OrgRepository


class UserRepository(OrgRepository[User]):
    model = User

    def by_email(self, email: str) -> User | None:
        query = self.scoped().where(User.email == email.lower())
        return self.session.scalars(query).first()

    def active(self, ids: list[int]) -> list[User]:
        query = self.scoped().where(User.id.in_(ids), User.active.is_(True))
        return list(self.session.scalars(query))
