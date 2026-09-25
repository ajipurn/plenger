"""One-case active runner entry point for OS-confined worker processes."""

from __future__ import annotations

import json
import math
import sys
from typing import Any

from plenger.broker.ipc import UnixBrokerEndpoint, UnixSocketRequestBroker
from plenger.policy.active import BudgetSpec, TargetSpec
from plenger.runner.cases import FIXED_CASES, run_case
from plenger.runner.observer import TrustedObserver

MAX_WORKER_FRAME_BYTES = 64 * 1024


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("active_worker_frame_invalid")
        value[key] = item
    return value


def _read_frame() -> dict[str, Any]:
    raw = sys.stdin.buffer.readline(MAX_WORKER_FRAME_BYTES + 1)
    if len(raw) > MAX_WORKER_FRAME_BYTES or not raw.endswith(b"\n"):
        raise ValueError("active_worker_frame_invalid")
    value = json.loads(raw, object_pairs_hook=_reject_duplicate_keys, parse_constant=lambda _: None)
    if not isinstance(value, dict):
        raise ValueError("active_worker_frame_invalid")
    return value


def _write_frame(value: dict[str, Any]) -> None:
    raw = json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    if len(raw) > MAX_WORKER_FRAME_BYTES:
        raise ValueError("active_worker_frame_too_large")
    sys.stdout.buffer.write(raw + b"\n")
    sys.stdout.buffer.flush()


class _ObserverRPC(TrustedObserver):
    def begin_attempt(self, case_id: str, run_id: str, attempt_id: str, sequence: int) -> None:
        _write_frame(
            {
                "op": "observer",
                "method": "begin_attempt",
                "case_id": case_id,
                "run_id": run_id,
                "attempt_id": attempt_id,
                "sequence": sequence,
            }
        )
        response = _read_frame()
        if response != {"ok": True}:
            raise ValueError("observer_unavailable")

    def trace_for(
        self, case_id: str, *, run_id: str | None = None, attempt_id: str | None = None
    ) -> dict[str, Any] | None:
        _write_frame(
            {
                "op": "observer",
                "method": "trace_for",
                "case_id": case_id,
                "run_id": run_id,
                "attempt_id": attempt_id,
            }
        )
        response = _read_frame()
        if set(response) == {"ok", "trace"} and response.get("ok") is True:
            trace = response.get("trace")
            return trace if isinstance(trace, dict) else None
        return None


def _validate_configuration(
    value: dict[str, Any],
) -> tuple[
    TargetSpec,
    BudgetSpec,
    UnixBrokerEndpoint,
    Any,
    str,
    str,
    str,
    int,
    float | None,
    bool,
]:
    expected = {
        "target",
        "budget",
        "broker_path",
        "broker_capability",
        "case_id",
        "method",
        "path",
        "run_id",
        "attempt_id",
        "sequence",
        "deadline",
        "observer_enabled",
    }
    if set(value) != expected:
        raise ValueError("active_worker_configuration_invalid")
    target = TargetSpec.model_validate(value["target"])
    budget = BudgetSpec.model_validate(value["budget"])
    socket_path = value["broker_path"]
    capability = value["broker_capability"]
    case_id = value["case_id"]
    method = value["method"]
    path = value["path"]
    run_id = value["run_id"]
    attempt_id = value["attempt_id"]
    sequence = value["sequence"]
    deadline = value["deadline"]
    observer_enabled = value["observer_enabled"]
    if (
        not isinstance(socket_path, str)
        or not socket_path
        or not isinstance(capability, str)
        or not capability
        or len(capability) > 256
        or not isinstance(case_id, str)
        or case_id not in FIXED_CASES
        or not isinstance(method, str)
        or method not in target.allowed_methods
        or not isinstance(path, str)
        or path not in target.allowed_paths
        or not isinstance(run_id, str)
        or not 1 <= len(run_id) <= 128
        or not isinstance(attempt_id, str)
        or not 1 <= len(attempt_id) <= 128
        or not isinstance(sequence, int)
        or isinstance(sequence, bool)
        or not 1 <= sequence <= 1_000_000
        or not isinstance(observer_enabled, bool)
    ):
        raise ValueError("active_worker_configuration_invalid")
    if deadline is not None and (
        not isinstance(deadline, (int, float))
        or isinstance(deadline, bool)
        or not math.isfinite(float(deadline))
    ):
        raise ValueError("active_worker_configuration_invalid")
    endpoint = UnixBrokerEndpoint(socket_path, capability)
    return (
        target,
        budget,
        endpoint,
        FIXED_CASES[case_id],
        method,
        path,
        run_id,
        sequence,
        None if deadline is None else float(deadline),
        observer_enabled,
    )


def main() -> None:
    value = _read_frame()
    (
        target,
        budget,
        endpoint,
        case,
        method,
        path,
        run_id,
        sequence,
        deadline,
        observer_enabled,
    ) = _validate_configuration(value)
    broker = UnixSocketRequestBroker(endpoint, target, budget)
    observer: TrustedObserver | None = _ObserverRPC() if observer_enabled else None
    result = run_case(
        broker,
        case,
        method,  # type: ignore[arg-type]
        path,
        deadline=deadline,
        observer=observer,
        run_id=run_id,
        attempt_id=value["attempt_id"],
        attempt_sequence=sequence,
    )
    _write_frame({"op": "result", "result": result})


if __name__ == "__main__":
    main()
