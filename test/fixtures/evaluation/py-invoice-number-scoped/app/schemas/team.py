from pydantic import BaseModel, Field

from app.schemas.common import Record


class TeamOut(Record):
    name: str
    description: str
    member_ids: list[int]


class TeamCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field("", max_length=500)


class MembershipChange(BaseModel):
    user_ids: list[int] = Field(min_length=1, max_length=200)
