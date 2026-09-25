"""Strict Pydantic base shared by every contract that crosses a trust boundary."""

from pydantic import BaseModel, ConfigDict


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
