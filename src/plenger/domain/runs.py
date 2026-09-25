"""Run states and the only allowed transitions between them."""

from enum import StrEnum


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
