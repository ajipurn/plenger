from pydantic import BaseModel, Field

from app.schemas.common import Record
from app.schemas.ticket import Priority


class SlaPolicyOut(Record):
    name: str
    priority: str
    first_response_minutes: int
    resolution_minutes: int
    business_hours_only: bool


class SlaPolicyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    priority: Priority
    first_response_minutes: int = Field(ge=5, le=60 * 24 * 14)
    resolution_minutes: int = Field(ge=15, le=60 * 24 * 90)
    business_hours_only: bool = True


class SlaPolicyUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=80)
    first_response_minutes: int | None = Field(None, ge=5, le=60 * 24 * 14)
    resolution_minutes: int | None = Field(None, ge=15, le=60 * 24 * 90)
    business_hours_only: bool | None = None
