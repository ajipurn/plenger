from dataclasses import dataclass

from fastapi import Query

from app.core.config import settings


@dataclass(frozen=True)
class Page:
    limit: int
    offset: int


def page_params(
    limit: int = Query(settings.default_page_size, ge=1, le=settings.max_page_size),
    offset: int = Query(0, ge=0),
) -> Page:
    return Page(limit=limit, offset=offset)
