from datetime import datetime
from typing import Generic, TypeVar

from pydantic import BaseModel, ConfigDict

Item = TypeVar("Item")


class Record(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime


class Listing(BaseModel, Generic[Item]):
    items: list[Item]
    total: int
    limit: int
    offset: int
