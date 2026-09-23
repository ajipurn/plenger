"""Small, strict contracts shared by CLI and HTTP services."""

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ProjectConfig(StrictModel):
    schema_version: Literal[1] = 1
    profile: Literal["deterministic", "baseline"] = "deterministic"
    max_files: int = Field(default=50000, ge=1, le=50000)
    max_file_bytes: int = Field(default=2097152, ge=1, le=2097152)
    max_total_bytes: int = Field(default=524288000, ge=1, le=524288000)

    @field_validator("schema_version", mode="before")
    @classmethod
    def integer_version(cls, value: Any) -> int:
        if type(value) is not int:
            raise ValueError("schema_version_requires_integer")
        return value

    # Config cannot grant consent, configure commands, or enable active/hosted work.


class RunState(StrEnum):
    PLANNED = "planned"
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    COMPLETED_WITH_ERRORS = "completed_with_errors"
    CANCELLING = "cancelling"
    CANCELLED = "cancelled"
    FAILED = "failed"
    INTERRUPTED = "interrupted"
    BLOCKED = "blocked"


TRANSITIONS = {
    RunState.PLANNED: {RunState.QUEUED, RunState.BLOCKED},
    RunState.QUEUED: {
        RunState.RUNNING,
        RunState.BLOCKED,
        RunState.CANCELLING,
        RunState.INTERRUPTED,
    },
    RunState.RUNNING: {
        RunState.COMPLETED,
        RunState.COMPLETED_WITH_ERRORS,
        RunState.CANCELLING,
        RunState.FAILED,
        RunState.INTERRUPTED,
    },
    RunState.CANCELLING: {RunState.CANCELLED, RunState.INTERRUPTED},
}


def transition(current: RunState, following: RunState) -> RunState:
    if following not in TRANSITIONS.get(current, set()):
        raise ValueError("invalid_state_transition")
    return following
