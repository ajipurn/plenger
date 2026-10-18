from app.models.attachment import Attachment
from app.repositories.base import OrgRepository


class AttachmentRepository(OrgRepository[Attachment]):
    model = Attachment

    def for_ticket(self, ticket_id: int) -> list[Attachment]:
        query = self.scoped().where(Attachment.ticket_id == ticket_id).order_by(Attachment.id)
        return list(self.session.scalars(query))
