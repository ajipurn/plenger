from pydantic import BaseModel, Field

from app.schemas.common import Record
from app.schemas.ticket import Priority, Status


class MacroOut(Record):
    title: str
    reply: str
    set_status: str | None
    set_priority: str | None
    add_tags: list[str]
    active: bool


class MacroCreate(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    reply: str = Field("", max_length=20000)
    set_status: Status | None = None
    set_priority: Priority | None = None
    add_tags: list[str] = Field(default_factory=list, max_length=10)
