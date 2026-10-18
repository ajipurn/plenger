from pydantic import BaseModel, Field

from app.schemas.common import Record


class CommentOut(Record):
    ticket_id: int
    author_id: int | None
    customer_id: int | None
    body: str
    public: bool


class CommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=20000)
    public: bool = True
