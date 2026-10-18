from sqlalchemy.orm import Session

from app.core.pagination import Page
from app.core.security import Principal
from app.models.satisfaction import SatisfactionRating
from app.repositories.satisfaction import SatisfactionRepository
from app.schemas.satisfaction import SatisfactionSummary


class SatisfactionService:
    def __init__(self, session: Session, principal: Principal):
        self.ratings = SatisfactionRepository(session, principal.org_id)

    def list(self, page: Page) -> tuple[list[SatisfactionRating], int]:
        return self.ratings.list(page)

    def summary(self, assignee_id: int | None) -> SatisfactionSummary:
        counts = self.ratings.score_counts(assignee_id)
        responses = sum(counts.values())
        average = (
            sum(score * count for score, count in counts.items()) / responses
            if responses
            else None
        )
        by_score = {score: counts.get(score, 0) for score in range(1, 6)}
        return SatisfactionSummary(responses=responses, average=average, by_score=by_score)
