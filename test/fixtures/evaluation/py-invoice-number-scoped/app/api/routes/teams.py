from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.api.deps import require
from app.core.db import get_session
from app.core.pagination import Page, page_params
from app.core.security import Principal
from app.models.team import Team
from app.schemas.common import Listing
from app.schemas.team import MembershipChange, TeamCreate, TeamOut
from app.services.teams import TeamService

router = APIRouter(prefix="/teams", tags=["teams"])


def team_out(team: Team) -> TeamOut:
    return TeamOut(
        id=team.id,
        created_at=team.created_at,
        name=team.name,
        description=team.description,
        member_ids=[member.id for member in team.members],
    )


@router.get("", response_model=Listing[TeamOut])
def list_teams(
    page: Page = Depends(page_params),
    principal: Principal = Depends(require("teams:read")),
    session: Session = Depends(get_session),
):
    teams, total = TeamService(session, principal).list(page)
    items = [team_out(team) for team in teams]
    return Listing(items=items, total=total, limit=page.limit, offset=page.offset)


@router.post("", response_model=TeamOut, status_code=status.HTTP_201_CREATED)
def create_team(
    data: TeamCreate,
    principal: Principal = Depends(require("teams:manage")),
    session: Session = Depends(get_session),
):
    return team_out(TeamService(session, principal).create(data))


@router.post("/{team_id}/members", response_model=TeamOut)
def add_members(
    team_id: int,
    change: MembershipChange,
    principal: Principal = Depends(require("teams:manage")),
    session: Session = Depends(get_session),
):
    return team_out(TeamService(session, principal).add_members(team_id, change.user_ids))
