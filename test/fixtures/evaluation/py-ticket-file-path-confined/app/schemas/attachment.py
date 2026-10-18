from app.schemas.common import Record


class AttachmentOut(Record):
    ticket_id: int
    filename: str
    content_type: str
    size: int
