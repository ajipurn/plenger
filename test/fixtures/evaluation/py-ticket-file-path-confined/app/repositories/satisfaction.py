from sqlalchemy import func, select

from app.models.satisfaction import SatisfactionRating
from app.repositories.base import OrgRepository


class SatisfactionRepository(OrgRepository[SatisfactionRating]):
    model = SatisfactionRating

    def score_counts(self, assignee_id: int | None = None) -> dict[int, int]:
        query = (
            select(SatisfactionRating.score, func.count())
            .where(SatisfactionRating.org_id == self.org_id)
            .group_by(SatisfactionRating.score)
        )
        if assignee_id is not None:
            query = query.where(SatisfactionRating.assignee_id == assignee_id)
        return {score: count for score, count in self.session.execute(query)}
