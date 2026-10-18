from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.common import Record

Status = Literal["new", "open", "pending", "on_hold", "solved", "closed"]
Priority = Literal["low", "normal", "high", "urgent"]


class TicketOut(Record):
    number: int
    subject: str
    status: str
    priority: str
    channel: str
    customer_id: int
    assignee_id: int | None
    team_id: int | None
    first_response_due: datetime | None
    solved_at: datetime | None
    tags: list[str]


class TicketCreate(BaseModel):
    subject: str = Field(min_length=1, max_length=200)
    customer_id: int
    priority: Priority = "normal"
    channel: Literal["email", "web", "phone", "chat"] = "web"
    body: str = Field(min_length=1, max_length=20000)


class TicketUpdate(BaseModel):
    subject: str | None = Field(None, min_length=1, max_length=200)
    status: Status | None = None
    priority: Priority | None = None
    team_id: int | None = None


class Assignment(BaseModel):
    assignee_id: int | None


class TicketFilter(BaseModel):
    status: Status | None = None
    priority: Priority | None = None
    assignee_id: int | None = None
    customer_id: int | None = None
    tag: str | None = Field(None, max_length=48)
