"""One reviewed case per confined worker process, spoken to over a framed pipe."""

import json
import os
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from plenger.runner.observer import TrustedObserver
from plenger.runner.sandbox import confined_worker_command
from plenger.services.active.broker import ActiveJobBroker


def _pipe_write(stream: Any, value: dict[str, Any]) -> None:
    encoded = (
        json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        + b"\n"
    )
    if len(encoded) > 64 * 1024:
        raise RuntimeError("active_worker_frame_too_large")
    descriptor = stream.fileno()
    view = memoryview(encoded)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise RuntimeError("active_worker_pipe_closed")
        view = view[written:]


def _worker_result(value: Any, case_id: str, category: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not {
        "case_id",
        "category",
        "result",
        "reason_code",
        "evidence",
    }.issubset(value):
        raise RuntimeError("active_worker_result_invalid")
    if set(value) - {
        "case_id",
        "category",
        "result",
        "reason_code",
        "http_status",
        "evidence",
    }:
        raise RuntimeError("active_worker_result_invalid")
    if (
        value["case_id"] != case_id
        or value["category"] != category
        or value["result"] not in {"pass", "fail", "error", "inconclusive"}
        or not isinstance(value["reason_code"], str)
        or not 1 <= len(value["reason_code"]) <= 128
        or not isinstance(value["evidence"], list)
        or len(value["evidence"]) > 32
        or any(not isinstance(item, str) or len(item) > 256 for item in value["evidence"])
    ):
        raise RuntimeError("active_worker_result_invalid")
    status = value.get("http_status")
    if status is not None and (
        not isinstance(status, int) or isinstance(status, bool) or not 100 <= status <= 599
    ):
        raise RuntimeError("active_worker_result_invalid")
    return value


def _stop_active_worker(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except OSError:
        process.terminate()
    try:
        process.wait(timeout=0.25)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            process.kill()
        process.wait(timeout=1)


def execute_confined_case(
    broker: ActiveJobBroker,
    case: Any,
    method: str,
    path: str,
    *,
    deadline: float,
    observer: TrustedObserver | None,
    run_id: str,
    attempt_id: str,
    attempt_sequence: int,
    cancelled: Any,
) -> dict[str, Any]:
    """Run one reviewed case in a process denied direct network access."""

    command, socket_path = confined_worker_command(Path(broker.endpoint.path))
    configuration = {
        "target": broker.target.model_dump(mode="json"),
        "budget": broker.budget.model_dump(mode="json"),
        "broker_path": socket_path,
        "broker_capability": broker.endpoint.capability,
        "case_id": case.case_id,
        "method": method,
        "path": path,
        "run_id": run_id,
        "attempt_id": attempt_id,
        "sequence": attempt_sequence,
        "deadline": deadline,
        "observer_enabled": observer is not None,
    }
    source_root = Path(__file__).resolve().parents[3]
    environment = {
        "HOME": "/nonexistent",
        "PATH": os.pathsep.join((str(Path(sys.executable).parent), "/usr/bin", "/bin")),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "PYTHONPATH": os.fspath(source_root),
    }
    try:
        process = subprocess.Popen(
            command,
            cwd="/",
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
            start_new_session=True,
        )
    except OSError:
        raise RuntimeError("active_worker_start_failed") from None
    assert process.stdin is not None and process.stdout is not None
    selector = selectors.DefaultSelector()
    output = bytearray()
    result: dict[str, Any] | None = None
    try:
        _pipe_write(process.stdin, configuration)
        descriptor = process.stdout.fileno()
        os.set_blocking(descriptor, False)
        selector.register(descriptor, selectors.EVENT_READ)
        while result is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _stop_active_worker(process)
                return {
                    "case_id": case.case_id,
                    "category": case.category,
                    "result": "error",
                    "reason_code": "wall_time_exhausted",
                    "evidence": [],
                }
            if cancelled():
                _stop_active_worker(process)
                return {
                    "case_id": case.case_id,
                    "category": case.category,
                    "result": "error",
                    "reason_code": "active_worker_cancelled",
                    "evidence": [],
                }
            ready = selector.select(min(0.1, remaining))
            if not ready:
                if process.poll() is not None:
                    raise RuntimeError("active_worker_failed")
                continue
            try:
                chunk = os.read(descriptor, 4096)
            except BlockingIOError:
                continue
            if not chunk:
                raise RuntimeError("active_worker_failed")
            output.extend(chunk)
            if len(output) > 64 * 1024:
                raise RuntimeError("active_worker_frame_too_large")
            while b"\n" in output:
                line, _, remainder = output.partition(b"\n")
                output = bytearray(remainder)
                try:
                    frame = json.loads(line, parse_constant=lambda _: None)
                except (json.JSONDecodeError, UnicodeDecodeError, TypeError, ValueError):
                    raise RuntimeError("active_worker_frame_invalid") from None
                if not isinstance(frame, dict) or not isinstance(frame.get("op"), str):
                    raise RuntimeError("active_worker_frame_invalid")
                if frame["op"] == "observer":
                    response = _observer_rpc_response(
                        frame,
                        observer,
                        case.case_id,
                        run_id,
                        attempt_id,
                        attempt_sequence,
                    )
                    _pipe_write(process.stdin, response)
                elif frame["op"] == "result" and set(frame) == {"op", "result"}:
                    result = _worker_result(frame["result"], case.case_id, case.category)
                else:
                    raise RuntimeError("active_worker_frame_invalid")
        try:
            return_code = process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            raise RuntimeError("active_worker_did_not_exit") from None
        if return_code != 0:
            raise RuntimeError("active_worker_failed")
        if output:
            raise RuntimeError("active_worker_frame_invalid")
        return result
    finally:
        selector.close()
        if process.poll() is None:
            _stop_active_worker(process)
        process.stdin.close()
        process.stdout.close()


def _observer_rpc_response(
    frame: dict[str, Any],
    observer: TrustedObserver | None,
    expected_case_id: str,
    expected_run_id: str,
    expected_attempt_id: str,
    expected_sequence: int,
) -> dict[str, Any]:
    if observer is None or frame.get("case_id") != expected_case_id:
        return {"ok": False}
    method = frame.get("method")
    if method == "begin_attempt" and set(frame) == {
        "op",
        "method",
        "case_id",
        "run_id",
        "attempt_id",
        "sequence",
    }:
        if (
            frame.get("run_id") != expected_run_id
            or frame.get("attempt_id") != expected_attempt_id
            or frame.get("sequence") != expected_sequence
        ):
            return {"ok": False}
        try:
            observer.begin_attempt(
                expected_case_id, expected_run_id, expected_attempt_id, expected_sequence
            )
        except (AttributeError, OSError, TypeError, ValueError):
            return {"ok": False}
        return {"ok": True}
    if method == "trace_for" and set(frame) == {
        "op",
        "method",
        "case_id",
        "run_id",
        "attempt_id",
    }:
        if frame.get("run_id") != expected_run_id or frame.get("attempt_id") != expected_attempt_id:
            return {"ok": False, "trace": None}
        try:
            trace = observer.trace_for(
                expected_case_id, run_id=expected_run_id, attempt_id=expected_attempt_id
            )
        except (AttributeError, OSError, TypeError, ValueError):
            trace = None
        return {"ok": True, "trace": trace if isinstance(trace, dict) else None}
    return {"ok": False}
