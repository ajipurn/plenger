from app.models.tag import Tag
from app.repositories.base import OrgRepository


class TagRepository(OrgRepository[Tag]):
    model = Tag

    def named(self, names: list[str]) -> list[Tag]:
        query = self.scoped().where(Tag.name.in_(names))
        return list(self.session.scalars(query))

    def all(self) -> list[Tag]:
        return list(self.session.scalars(self.scoped().order_by(Tag.name)))
