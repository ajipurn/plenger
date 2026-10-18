from sqlalchemy.orm import selectinload

from app.models.team import Team
from app.repositories.base import OrgRepository


class TeamRepository(OrgRepository[Team]):
    model = Team

    def with_members(self, team_id: int) -> Team | None:
        query = self.scoped().options(selectinload(Team.members)).where(Team.id == team_id)
        return self.session.scalars(query).first()
