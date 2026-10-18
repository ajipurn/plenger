from sqlalchemy.orm import Session

from app.core.errors import Invalid, NotFound
from app.core.pagination import Page
from app.core.security import Principal
from app.models.team import Team
from app.repositories.teams import TeamRepository
from app.repositories.users import UserRepository
from app.schemas.team import TeamCreate
from app.services.audit_events import AuditService


class TeamService:
    def __init__(self, session: Session, principal: Principal):
        self.teams = TeamRepository(session, principal.org_id)
        self.users = UserRepository(session, principal.org_id)
        self.audit = AuditService(session, principal)

    def get(self, team_id: int) -> Team:
        team = self.teams.with_members(team_id)
        if team is None:
            raise NotFound("team")
        return team

    def list(self, page: Page) -> tuple[list[Team], int]:
        return self.teams.list(page)

    def create(self, data: TeamCreate) -> Team:
        team = self.teams.add(Team(name=data.name, description=data.description))
        self.audit.record("team.created", "team", team.id)
        return team

    def add_members(self, team_id: int, user_ids: list[int]) -> Team:
        team = self.get(team_id)
        users = self.users.active(user_ids)
        if len(users) != len(set(user_ids)):
            raise Invalid("every member must be an active user of this organization")
        known = {member.id for member in team.members}
        team.members.extend(user for user in users if user.id not in known)
        self.audit.record("team.members_added", "team", team.id, user_ids=user_ids)
        return team
