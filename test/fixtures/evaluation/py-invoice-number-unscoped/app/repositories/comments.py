from app.core.pagination import Page
from app.models.comment import Comment
from app.repositories.base import OrgRepository


class CommentRepository(OrgRepository[Comment]):
    model = Comment

    def for_ticket(
        self, ticket_id: int, page: Page, *, public_only: bool
    ) -> tuple[list[Comment], int]:
        query = self.scoped().where(Comment.ticket_id == ticket_id)
        if public_only:
            query = query.where(Comment.public.is_(True))
        return self.page(query, page)
