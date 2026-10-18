from typing import Generic, TypeVar

from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from app.core.db import Base
from app.core.pagination import Page

Model = TypeVar("Model", bound=Base)


class OrgRepository(Generic[Model]):
    """Data access for the rows of one model that belong to one organization."""

    model: type[Model]

    def __init__(self, session: Session, org_id: int):
        self.session = session
        self.org_id = org_id

    def scoped(self) -> Select[tuple[Model]]:
        return select(self.model).where(self.model.org_id == self.org_id)

    def get(self, row_id: int) -> Model | None:
        return self.session.scalars(self.scoped().where(self.model.id == row_id)).first()

    def page(self, query: Select[tuple[Model]], page: Page) -> tuple[list[Model], int]:
        total = self.session.scalar(select(func.count()).select_from(query.subquery())) or 0
        rows = self.session.scalars(
            query.order_by(self.model.id.desc()).limit(page.limit).offset(page.offset)
        )
        return list(rows), total

    def list(self, page: Page) -> tuple[list[Model], int]:
        return self.page(self.scoped(), page)

    def add(self, row: Model) -> Model:
        row.org_id = self.org_id
        self.session.add(row)
        self.session.flush()
        return row

    def remove(self, row: Model) -> None:
        self.session.delete(row)
        self.session.flush()
