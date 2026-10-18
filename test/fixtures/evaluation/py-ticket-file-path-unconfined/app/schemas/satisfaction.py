from pydantic import BaseModel

from app.schemas.common import Record


class RatingOut(Record):
    ticket_id: int
    customer_id: int
    assignee_id: int | None
    score: int
    comment: str


class SatisfactionSummary(BaseModel):
    responses: int
    average: float | None
    by_score: dict[int, int]
