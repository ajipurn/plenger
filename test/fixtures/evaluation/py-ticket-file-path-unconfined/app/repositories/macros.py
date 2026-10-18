from app.models.macro import Macro
from app.repositories.base import OrgRepository


class MacroRepository(OrgRepository[Macro]):
    model = Macro

    def active(self) -> list[Macro]:
        query = self.scoped().where(Macro.active.is_(True)).order_by(Macro.title)
        return list(self.session.scalars(query))
