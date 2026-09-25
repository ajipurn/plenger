"""Bounded job-scoped Unix-socket transport for the active request broker."""

from __future__ import annotations

import json
import math
import os
import secrets
import socket
import socketserver
import stat
import threading
import time
from dataclasses import dataclass
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Any

from plenger.broker import BrokerError, DispatchOutcome, RequestBroker
from plenger.policy.active import BudgetSpec, TargetSpec

MAX_BROKER_FRAME_BYTES = 64 * 1024
MAX_BROKER_PAYLOAD_BYTES = 32 * 1024
MAX_BROKER_PATH_BYTES = 4096
MAX_BROKER_REMAINING_SECONDS = 600.0


def active_runner_capability() -> dict[str, str]:
    """Report whether a network-isolated active worker can run on this host."""

    if os.name != "posix" or not hasattr(os, "getuid") or not hasattr(socket, "AF_UNIX"):
        return {"status": "unavailable", "reason": "posix_unix_socket_required"}
    from plenger.runner.sandbox import active_worker_capability

    return active_worker_capability()


def _reject_json_constant(_: str) -> Any:
    raise ValueError("invalid_broker_frame")


def _reject_duplicate_json_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("invalid_broker_frame")
        value[key] = item
    return value


def _encode_frame(value: dict[str, Any]) -> bytes:
    try:
        encoded = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    except (TypeError, ValueError, OverflowError):
        raise BrokerError("invalid_broker_frame") from None
    if len(encoded) > MAX_BROKER_FRAME_BYTES:
        raise BrokerError("broker_frame_too_large")
    return encoded


def _validate_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise BrokerError("invalid_request_payload")
    try:
        encoded = json.dumps(payload, allow_nan=False, separators=(",", ":")).encode()
    except (TypeError, ValueError, OverflowError):
        raise BrokerError("invalid_request_payload") from None
    if len(encoded) > MAX_BROKER_PAYLOAD_BYTES:
        raise BrokerError("request_too_large")
    return payload


def _validate_remaining(value: Any) -> float | None:
    if value is None:
        return None
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise BrokerError("invalid_broker_deadline")
    remaining = float(value)
    if not math.isfinite(remaining) or not 0.0 < remaining <= MAX_BROKER_REMAINING_SECONDS:
        raise BrokerError("invalid_broker_deadline")
    return remaining


@dataclass(frozen=True)
class UnixBrokerEndpoint:
    """In-memory capability needed to connect to one active broker job."""

    path: str
    capability: str


class _UnixBrokerServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    block_on_close = True

    def __init__(self, path: Path, broker: RequestBroker, capability: str) -> None:
        self.broker = broker
        self.capability = capability
        super().__init__(str(path), _UnixBrokerHandler)


class _UnixBrokerHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        server = self.server
        if not isinstance(server, _UnixBrokerServer):
            return
        self.request.settimeout(1.0)
        try:
            raw = self.rfile.readline(MAX_BROKER_FRAME_BYTES + 1)
            if len(raw) > MAX_BROKER_FRAME_BYTES or not raw.endswith(b"\n"):
                self._reply_error("invalid_broker_frame")
                return
            frame = json.loads(
                raw,
                object_pairs_hook=_reject_duplicate_json_keys,
                parse_constant=_reject_json_constant,
            )
            if (
                not isinstance(frame, dict)
                or set(frame) != {"capability", "op", "request"}
                or not isinstance(frame.get("capability"), str)
                or not secrets.compare_digest(frame["capability"], server.capability)
                or not isinstance(frame.get("op"), str)
                or not isinstance(frame.get("request"), dict)
            ):
                self._reply_error("broker_capability_invalid")
                return
            response = self._dispatch_frame(server, frame["op"], frame["request"])
            self.wfile.write(_encode_frame(response) + b"\n")
        except (
            BrokerError,
            OSError,
            RecursionError,
            TypeError,
            ValueError,
            json.JSONDecodeError,
        ) as exc:
            code = str(exc)[:128] if isinstance(exc, BrokerError) else "invalid_broker_frame"
            self._reply_error(code)

    def _dispatch_frame(
        self, server: _UnixBrokerServer, operation: str, request: dict[str, Any]
    ) -> dict[str, Any]:
        if operation == "cancel":
            if request:
                raise BrokerError("invalid_broker_request")
            server.broker.cancel()
            return {"ok": True, "cancelled": True}
        if operation == "stats":
            if request:
                raise BrokerError("invalid_broker_request")
            return {"ok": True, "stats": server.broker.stats()}
        if operation != "dispatch" or set(request) != {
            "method",
            "path",
            "payload",
            "remaining_seconds",
        }:
            raise BrokerError("invalid_broker_request")
        method = request["method"]
        path = request["path"]
        if not isinstance(method, str) or not 1 <= len(method) <= 16:
            raise BrokerError("invalid_broker_request")
        if (
            not isinstance(path, str)
            or not 1 <= len(path) <= MAX_BROKER_PATH_BYTES
            or len(path.encode()) > MAX_BROKER_PATH_BYTES
        ):
            raise BrokerError("invalid_broker_request")
        payload = _validate_payload(request["payload"])
        remaining = _validate_remaining(request["remaining_seconds"])
        deadline = time.monotonic() + remaining if remaining is not None else None
        outcome = server.broker.dispatch(method, path, payload, deadline=deadline)
        return {
            "ok": True,
            "outcome": {
                "attempt": outcome.attempt,
                "status_code": outcome.status_code,
                "body_excerpt": outcome.body_excerpt,
                "response_truncated": outcome.response_truncated,
                "redirect_received": outcome.redirect_received,
            },
        }

    def _reply_error(self, code: str) -> None:
        try:
            self.wfile.write(_encode_frame({"ok": False, "error": code[:128]}) + b"\n")
        except OSError:
            return


class UnixBrokerServer:
    """Own a capability-protected Unix socket for one bounded broker job."""

    def __init__(self, broker: RequestBroker, path: Path, *, capability: str | None = None) -> None:
        if not isinstance(broker, RequestBroker):
            raise ValueError("broker_socket_requires_request_broker")
        if capability is not None and (not capability or len(capability) > 256):
            raise ValueError("invalid_broker_capability")
        self._broker = broker
        self._path = path.resolve()
        self._capability = capability or secrets.token_urlsafe(32)
        self._server: _UnixBrokerServer | None = None
        self._thread: threading.Thread | None = None
        self._identity: tuple[int, int] | None = None

    @property
    def endpoint(self) -> UnixBrokerEndpoint:
        if self._server is None:
            raise RuntimeError("broker_socket_not_started")
        return UnixBrokerEndpoint(str(self._path), self._capability)

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> UnixBrokerEndpoint:
        if self._server is not None:
            raise RuntimeError("broker_socket_already_started")
        if not hasattr(os, "getuid") or not hasattr(socket, "AF_UNIX"):
            raise ValueError("broker_unix_socket_unavailable")
        if len(os.fsencode(self._path)) > 104:
            raise ValueError("broker_socket_path_too_long")
        parent = self._path.parent
        try:
            parent_stat = os.stat(parent)
        except OSError:
            raise ValueError("broker_socket_parent_unavailable") from None
        if (
            not stat.S_ISDIR(parent_stat.st_mode)
            or parent_stat.st_uid != os.getuid()
            or parent_stat.st_mode & 0o022
            or self._path.exists()
        ):
            raise ValueError("broker_socket_path_unsafe")
        server: _UnixBrokerServer | None = None
        bind_attempted = False
        try:
            bind_attempted = True
            server = _UnixBrokerServer(self._path, self._broker, self._capability)
            identity = os.lstat(self._path)
            if not stat.S_ISSOCK(identity.st_mode) or identity.st_uid != os.getuid():
                raise ValueError("broker_socket_path_unsafe")
            self._identity = (identity.st_dev, identity.st_ino)
            os.chmod(self._path, 0o600)
            current = os.lstat(self._path)
            if (
                not stat.S_ISSOCK(current.st_mode)
                or current.st_uid != os.getuid()
                or (current.st_dev, current.st_ino) != self._identity
            ):
                raise ValueError("broker_socket_path_unsafe")
        except (OSError, ValueError):
            if server is not None:
                server.server_close()
            if bind_attempted and self._identity is None:
                self._remove_failed_socket()
            self._remove_socket()
            raise
        assert server is not None
        self._server = server
        self._thread = threading.Thread(
            target=server.serve_forever,
            kwargs={"poll_interval": 0.1},
            name="plenger-broker-socket",
            daemon=True,
        )
        self._thread.start()
        return self.endpoint

    def close(self) -> None:
        server = self._server
        thread = self._thread
        self._server = None
        self._thread = None
        if server is not None:
            server.shutdown()
            server.server_close()
        if thread is not None:
            thread.join(timeout=2)
        self._remove_socket()

    def _remove_socket(self) -> None:
        if self._identity is None:
            return
        try:
            current = os.lstat(self._path)
            if (
                stat.S_ISSOCK(current.st_mode)
                and (
                    current.st_dev,
                    current.st_ino,
                )
                == self._identity
            ):
                self._path.unlink()
        except OSError:
            pass
        finally:
            self._identity = None

    def _remove_failed_socket(self) -> None:
        try:
            current = os.lstat(self._path)
            if stat.S_ISSOCK(current.st_mode) and current.st_uid == os.getuid():
                self._path.unlink()
        except OSError:
            return

    def __enter__(self) -> UnixBrokerServer:
        self.start()
        return self

    def __exit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
        self.close()


def _run_unix_broker_process(
    path: str,
    capability: str,
    target: TargetSpec,
    budget: BudgetSpec,
    ready: Connection,
) -> None:
    """Run a broker child without importing plenger's service/database layer."""

    parent_pid = os.getppid()
    server: UnixBrokerServer | None = None
    try:
        server = UnixBrokerServer(
            RequestBroker(target, budget),
            Path(path),
            capability=capability,
        )
        server.start()
        ready.send({"ok": True})
        while server.running and os.getppid() == parent_pid:
            time.sleep(0.05)
    except BaseException:
        try:
            ready.send({"ok": False})
        except (EOFError, OSError):
            pass
    finally:
        if server is not None:
            server.close()
        try:
            Path(path).parent.rmdir()
        except OSError:
            pass


class UnixSocketRequestBroker(RequestBroker):
    """RequestBroker-compatible client for a job-scoped Unix broker socket."""

    def __init__(
        self,
        endpoint: UnixBrokerEndpoint,
        target: TargetSpec,
        budget: BudgetSpec,
        *,
        timeout_seconds: float = 1.0,
    ) -> None:
        if not isinstance(endpoint, UnixBrokerEndpoint) or not endpoint.path:
            raise ValueError("invalid_broker_endpoint")
        if not endpoint.capability or len(endpoint.capability) > 256:
            raise ValueError("invalid_broker_endpoint")
        if not isinstance(target, TargetSpec) or not isinstance(budget, BudgetSpec):
            raise ValueError("invalid_broker_configuration")
        if not 0.1 <= timeout_seconds <= 5.0:
            raise ValueError("broker_socket_timeout_invalid")
        super().__init__(target, budget)
        self._endpoint = endpoint
        self._timeout_seconds = timeout_seconds

    def _round_trip(self, operation: str, request: dict[str, Any]) -> dict[str, Any]:
        return self._round_trip_with_timeout(operation, request)

    def _round_trip_with_timeout(
        self,
        operation: str,
        request: dict[str, Any],
        *,
        response_timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        frame = _encode_frame(
            {"capability": self._endpoint.capability, "op": operation, "request": request}
        )
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(self._timeout_seconds)
                connection.connect(self._endpoint.path)
                connection.sendall(frame + b"\n")
                if response_timeout_seconds is not None:
                    connection.settimeout(
                        min(
                            MAX_BROKER_REMAINING_SECONDS + 1.0,
                            max(self._timeout_seconds, response_timeout_seconds),
                        )
                    )
                with connection.makefile("rb") as response_stream:
                    raw = response_stream.readline(MAX_BROKER_FRAME_BYTES + 1)
        except (OSError, TimeoutError):
            raise BrokerError("broker_transport_failed") from None
        if len(raw) > MAX_BROKER_FRAME_BYTES or not raw.endswith(b"\n"):
            raise BrokerError("broker_protocol_invalid")
        try:
            response = json.loads(
                raw,
                object_pairs_hook=_reject_duplicate_json_keys,
                parse_constant=_reject_json_constant,
            )
        except (RecursionError, UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
            raise BrokerError("broker_protocol_invalid") from None
        if not isinstance(response, dict) or not isinstance(response.get("ok"), bool):
            raise BrokerError("broker_protocol_invalid")
        if not response["ok"]:
            error = response.get("error")
            raise BrokerError(error if isinstance(error, str) else "broker_request_failed")
        return response

    def dispatch(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        deadline: float | None = None,
    ) -> DispatchOutcome:
        body = _validate_payload({} if payload is None else payload)
        remaining = None if deadline is None else deadline - time.monotonic()
        if remaining is not None and remaining <= 0:
            raise BrokerError("wall_time_exhausted")
        response_timeout = self.budget.request_timeout_seconds + 1.0
        if remaining is not None:
            response_timeout = min(response_timeout, remaining + 1.0)
        response = self._round_trip_with_timeout(
            "dispatch",
            {
                "method": method,
                "path": path,
                "payload": body,
                "remaining_seconds": remaining,
            },
            response_timeout_seconds=response_timeout,
        )
        outcome = response.get("outcome")
        if not isinstance(outcome, dict) or set(outcome) != {
            "attempt",
            "status_code",
            "body_excerpt",
            "response_truncated",
            "redirect_received",
        }:
            raise BrokerError("broker_protocol_invalid")
        attempt = outcome["attempt"]
        status_code = outcome["status_code"]
        excerpt = outcome["body_excerpt"]
        response_truncated = outcome["response_truncated"]
        redirect_received = outcome["redirect_received"]
        if (
            not isinstance(attempt, int)
            or isinstance(attempt, bool)
            or attempt < 1
            or not isinstance(status_code, int)
            or isinstance(status_code, bool)
            or not 100 <= status_code <= 599
            or not isinstance(excerpt, str)
            or len(excerpt) > 2000
            or not isinstance(response_truncated, bool)
            or not isinstance(redirect_received, bool)
        ):
            raise BrokerError("broker_protocol_invalid")
        return DispatchOutcome(
            attempt=attempt,
            status_code=status_code,
            body_excerpt=excerpt,
            response_truncated=response_truncated,
            redirect_received=redirect_received,
        )

    def cancel(self) -> None:
        self._round_trip("cancel", {})

    def stats(self) -> dict[str, Any]:
        response = self._round_trip("stats", {})
        stats = response.get("stats")
        if (
            not isinstance(stats, dict)
            or not isinstance(stats.get("reserved_attempts"), int)
            or isinstance(stats.get("reserved_attempts"), bool)
            or stats["reserved_attempts"] < 0
            or not isinstance(stats.get("cancelled"), bool)
        ):
            raise BrokerError("broker_protocol_invalid")
        return {
            "reserved_attempts": stats["reserved_attempts"],
            "cancelled": stats["cancelled"],
        }


__all__ = [
    "UnixBrokerEndpoint",
    "UnixBrokerServer",
    "UnixSocketRequestBroker",
    "active_runner_capability",
]
