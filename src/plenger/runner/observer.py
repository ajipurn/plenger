"""Trusted observers for effects a target response cannot prove.

Fixture observers record independent facts in memory; the signed observer accepts
HMAC-signed envelopes from an approved sidecar, optionally over a Unix socket.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import socketserver
import stat
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

MAX_OBSERVER_EVENT_BYTES = 64 * 1024
MAX_OBSERVER_SEQUENCE = 1_000_000
MAX_OBSERVER_SECRET_BYTES = 4096
MIN_OBSERVER_SECRET_BYTES = 32


def load_observer_secret(path: Path) -> bytes:
    """Read an owner-only observer key without following the final symlink."""

    try:
        descriptor = os.open(
            os.fspath(path),
            os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0),
        )
    except (OSError, TypeError):
        raise ValueError("observer_secret_unavailable") from None
    try:
        initial = os.fstat(descriptor)
        if (
            not stat.S_ISREG(initial.st_mode)
            or initial.st_nlink != 1
            or initial.st_uid != os.getuid()
            or stat.S_IMODE(initial.st_mode) not in {0o400, 0o600}
            or not MIN_OBSERVER_SECRET_BYTES <= initial.st_size <= MAX_OBSERVER_SECRET_BYTES
        ):
            raise ValueError("observer_secret_unsafe")
        secret = bytearray()
        while len(secret) <= MAX_OBSERVER_SECRET_BYTES:
            chunk = os.read(descriptor, min(65536, MAX_OBSERVER_SECRET_BYTES + 1 - len(secret)))
            if not chunk:
                break
            secret.extend(chunk)
        final = os.fstat(descriptor)
        if (
            (initial.st_dev, initial.st_ino, initial.st_size)
            != (final.st_dev, final.st_ino, final.st_size)
            or len(secret) != initial.st_size
            or not MIN_OBSERVER_SECRET_BYTES <= len(secret) <= MAX_OBSERVER_SECRET_BYTES
        ):
            raise ValueError("observer_secret_changed")
        return bytes(secret)
    except OSError:
        raise ValueError("observer_secret_unavailable") from None
    finally:
        os.close(descriptor)


class TrustedObserver(Protocol):
    """Side-channel observer for effects the target response cannot prove."""

    def begin_attempt(self, case_id: str, run_id: str, attempt_id: str, sequence: int) -> None: ...

    def trace_for(
        self, case_id: str, *, run_id: str | None = None, attempt_id: str | None = None
    ) -> dict[str, Any] | None: ...


def validate_attempt_context(case_id: str, run_id: str, attempt_id: str, sequence: int) -> None:
    if (
        not isinstance(case_id, str)
        or not 1 <= len(case_id) <= 128
        or not isinstance(run_id, str)
        or not 1 <= len(run_id) <= 128
        or not isinstance(attempt_id, str)
        or not 1 <= len(attempt_id) <= 128
        or not isinstance(sequence, int)
        or isinstance(sequence, bool)
        or not 1 <= sequence <= MAX_OBSERVER_SEQUENCE
    ):
        raise ValueError("invalid_observer_attempt_context")


def _safe_trace(trace: dict[str, Any]) -> dict[str, Any]:
    safe: dict[str, Any] = {}
    for key in (
        "trace_id",
        "authenticated_subject",
        "tool_name",
        "authorization_decision",
        "approval_ref",
        "outcome",
    ):
        value = trace.get(key)
        if isinstance(value, (str, bool)):
            safe[key] = str(value)[:256] if isinstance(value, str) else value
    retrieved = trace.get("retrieved_doc_ids")
    if isinstance(retrieved, list) and len(retrieved) <= 256:
        safe["retrieved_doc_ids"] = [str(item)[:256] for item in retrieved if isinstance(item, str)]
    if not safe:
        raise ValueError("observer_trace_empty")
    return safe


def _copy_trace(trace: dict[str, Any]) -> dict[str, Any]:
    copied = dict(trace)
    retrieved = copied.get("retrieved_doc_ids")
    if isinstance(retrieved, list):
        copied["retrieved_doc_ids"] = list(retrieved)
    return copied


def _canonical_trace_event(envelope: dict[str, Any]) -> bytes:
    try:
        encoded = json.dumps(
            envelope,
            allow_nan=False,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    except (TypeError, ValueError, OverflowError):
        raise ValueError("invalid_observer_event") from None
    if len(encoded) > MAX_OBSERVER_EVENT_BYTES:
        raise ValueError("observer_event_too_large")
    return encoded


def sign_trace_event(secret: bytes, envelope: dict[str, Any]) -> str:
    """Sign a strict observer envelope for a trusted sidecar transport."""

    if not isinstance(secret, bytes) or len(secret) < 32:
        raise ValueError("observer_signing_key_too_short")
    if not isinstance(envelope, dict):
        raise ValueError("invalid_observer_event")
    return hmac.new(secret, _canonical_trace_event(envelope), hashlib.sha256).hexdigest()


def _reject_json_constant(_: str) -> Any:
    raise ValueError("invalid_observer_event")


def _reject_duplicate_json_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("invalid_observer_event")
        value[key] = item
    return value


class FixtureObserver:
    """Small in-memory observer used by explicitly labeled local fixtures.

    The target response is never used to populate this ledger.  A fixture or
    test-only sidecar records bounded facts independently, and the runner only
    reads the sanitized copy after dispatch.
    """

    def __init__(self) -> None:
        self._traces: dict[tuple[str, str | None, str | None], dict[str, Any]] = {}
        self._contexts: dict[str, tuple[str, str, int]] = {}
        self._lock = threading.Lock()

    def begin_attempt(self, case_id: str, run_id: str, attempt_id: str, sequence: int) -> None:
        validate_attempt_context(case_id, run_id, attempt_id, sequence)
        with self._lock:
            self._contexts[case_id] = (run_id, attempt_id, sequence)

    def record(self, case_id: str, trace: dict[str, Any]) -> None:
        if not isinstance(case_id, str) or len(case_id) > 128 or not isinstance(trace, dict):
            raise ValueError("invalid_observer_event")
        safe = _safe_trace(trace)
        with self._lock:
            context = self._contexts.get(case_id)
            trace_key: tuple[str, str | None, str | None]
            if context is None:
                trace_key = (case_id, None, None)
            else:
                run_id, attempt_id, sequence = context
                safe.update(
                    {
                        "run_id": run_id,
                        "attempt_id": attempt_id,
                        "sequence": sequence,
                        "timestamp": datetime.now(UTC).isoformat(),
                    }
                )
                trace_key = (case_id, run_id, attempt_id)
            self._traces[trace_key] = safe

    def trace_for(
        self, case_id: str, *, run_id: str | None = None, attempt_id: str | None = None
    ) -> dict[str, Any] | None:
        if (run_id is None) != (attempt_id is None):
            return None
        with self._lock:
            trace = self._traces.get((case_id, run_id, attempt_id))
            return _copy_trace(trace) if trace is not None else None


class SignedTraceObserver:
    """Bounded HMAC-verified observer ingress for an external sidecar.

    The active runner still owns the attempt context. A sidecar can submit only
    a signed envelope matching the context opened immediately before dispatch;
    response JSON remains untrusted and cannot populate this observer.
    """

    _EVENT_KEYS = {
        "event_id",
        "case_id",
        "run_id",
        "attempt_id",
        "sequence",
        "timestamp",
        "trace",
    }

    def __init__(self, secret: bytes, *, max_events: int = 256) -> None:
        if not isinstance(secret, bytes) or len(secret) < 32:
            raise ValueError("observer_signing_key_too_short")
        if (
            not isinstance(max_events, int)
            or isinstance(max_events, bool)
            or not 1 <= max_events <= 4096
        ):
            raise ValueError("observer_event_capacity_invalid")
        self._secret = bytes(secret)
        self._max_events = max_events
        self._contexts: dict[tuple[str, str, str], int] = {}
        self._events: dict[tuple[str, str, str], dict[str, Any]] = {}
        self._event_ids: set[str] = set()
        self._lock = threading.Lock()

    def begin_attempt(self, case_id: str, run_id: str, attempt_id: str, sequence: int) -> None:
        validate_attempt_context(case_id, run_id, attempt_id, sequence)
        with self._lock:
            context_key = (case_id, run_id, attempt_id)
            if context_key not in self._contexts and len(self._contexts) >= self._max_events:
                raise ValueError("observer_context_capacity_exceeded")
            self._contexts[context_key] = sequence

    def ingest_json(self, payload: bytes | str, signature: str) -> None:
        """Verify one bounded JSON body from an approved sidecar transport."""

        try:
            if isinstance(payload, str):
                encoded = payload.encode()
            elif isinstance(payload, bytes):
                encoded = payload
            else:
                raise ValueError("invalid_observer_event")
        except UnicodeError:
            raise ValueError("invalid_observer_event") from None
        if len(encoded) > MAX_OBSERVER_EVENT_BYTES:
            raise ValueError("observer_event_too_large")
        try:
            envelope = json.loads(
                encoded,
                object_pairs_hook=_reject_duplicate_json_keys,
                parse_constant=_reject_json_constant,
            )
        except (RecursionError, UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
            raise ValueError("invalid_observer_event") from None
        if not isinstance(envelope, dict):
            raise ValueError("invalid_observer_event")
        self.ingest(envelope, signature)

    def ingest(self, envelope: dict[str, Any], signature: str) -> None:
        if not isinstance(envelope, dict) or set(envelope) != self._EVENT_KEYS:
            raise ValueError("invalid_observer_event")
        if (
            not isinstance(signature, str)
            or len(signature) != hashlib.sha256().digest_size * 2
            or any(character not in "0123456789abcdef" for character in signature)
            or not hmac.compare_digest(signature, sign_trace_event(self._secret, envelope))
        ):
            raise ValueError("observer_signature_invalid")
        event_id = envelope.get("event_id")
        case_id = envelope.get("case_id")
        run_id = envelope.get("run_id")
        attempt_id = envelope.get("attempt_id")
        sequence = envelope.get("sequence")
        timestamp = envelope.get("timestamp")
        trace = envelope.get("trace")
        if (
            not isinstance(event_id, str)
            or not 1 <= len(event_id) <= 128
            or not isinstance(case_id, str)
            or not 1 <= len(case_id) <= 128
            or not isinstance(run_id, str)
            or not 1 <= len(run_id) <= 128
            or not isinstance(attempt_id, str)
            or not 1 <= len(attempt_id) <= 128
            or not isinstance(sequence, int)
            or isinstance(sequence, bool)
            or not 1 <= sequence <= MAX_OBSERVER_SEQUENCE
            or not isinstance(timestamp, str)
            or not 1 <= len(timestamp) <= 64
            or not isinstance(trace, dict)
        ):
            raise ValueError("invalid_observer_event")
        try:
            parsed_timestamp = datetime.fromisoformat(timestamp)
        except ValueError:
            raise ValueError("invalid_observer_timestamp") from None
        if parsed_timestamp.tzinfo is None:
            raise ValueError("observer_timestamp_requires_timezone")
        safe = _safe_trace(trace)
        with self._lock:
            context_key = (case_id, run_id, attempt_id)
            if event_id in self._event_ids:
                raise ValueError("observer_event_replay")
            context_sequence = self._contexts.get(context_key)
            if context_sequence != sequence:
                raise ValueError("observer_attempt_mismatch")
            event_key = (case_id, run_id, attempt_id)
            if event_key in self._events:
                raise ValueError("observer_event_duplicate")
            if len(self._events) >= self._max_events:
                raise ValueError("observer_event_capacity_exceeded")
            safe.update(
                {
                    "event_id": event_id,
                    "run_id": run_id,
                    "attempt_id": attempt_id,
                    "sequence": sequence,
                    "timestamp": timestamp,
                }
            )
            self._events[event_key] = safe
            self._event_ids.add(event_id)
            self._contexts.pop(context_key, None)

    def trace_for(
        self, case_id: str, *, run_id: str | None = None, attempt_id: str | None = None
    ) -> dict[str, Any] | None:
        if (run_id is None) != (attempt_id is None):
            return None
        if run_id is None or attempt_id is None:
            return None
        with self._lock:
            trace = self._events.get((case_id, run_id, attempt_id))
            return _copy_trace(trace) if trace is not None else None

    def forget_run(self, run_id: str) -> None:
        """Release bounded observer state after an active run is finalized."""

        if not isinstance(run_id, str) or not run_id:
            return
        with self._lock:
            event_keys = [key for key in self._events if key[1] == run_id]
            for key in event_keys:
                event = self._events.pop(key)
                event_id = event.get("event_id")
                if isinstance(event_id, str):
                    self._event_ids.discard(event_id)
            context_keys = [key for key in self._contexts if key[1] == run_id]
            for key in context_keys:
                self._contexts.pop(key, None)


@dataclass(frozen=True)
class SignedTraceSocketEndpoint:
    """Capability required by a local observer sidecar connection."""

    path: str
    capability: str


class _SignedTraceSocketServer(socketserver.UnixStreamServer):
    def __init__(self, path: Path, observer: SignedTraceObserver, capability: str) -> None:
        self.observer = observer
        self.capability = capability
        super().__init__(str(path), _SignedTraceSocketHandler)


class _SignedTraceSocketHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        server = self.server
        if not isinstance(server, _SignedTraceSocketServer):
            return
        self.request.settimeout(1.0)
        frame_limit = MAX_OBSERVER_EVENT_BYTES + 1024
        try:
            raw = self.rfile.readline(frame_limit + 1)
            if len(raw) > frame_limit or not raw.endswith(b"\n"):
                self._reject()
                return
            frame = json.loads(
                raw,
                object_pairs_hook=_reject_duplicate_json_keys,
                parse_constant=_reject_json_constant,
            )
            if (
                not isinstance(frame, dict)
                or set(frame) != {"capability", "signature", "event"}
                or not isinstance(frame.get("capability"), str)
                or not secrets.compare_digest(frame["capability"], server.capability)
                or not isinstance(frame.get("event"), dict)
                or not isinstance(frame.get("signature"), str)
            ):
                self._reject()
                return
            server.observer.ingest(frame["event"], frame["signature"])
            self.wfile.write(b'{"accepted":true}\n')
        except (OSError, RecursionError, TypeError, ValueError, json.JSONDecodeError):
            self._reject()

    def _reject(self) -> None:
        try:
            self.wfile.write(b'{"accepted":false}\n')
        except OSError:
            return


class SignedTraceObserverSocket:
    """Opt-in bounded Unix-socket ingress for an approved local sidecar.

    The socket is deliberately separate from the HTTP API. A caller owns the
    runtime directory and receives a per-instance capability in memory; each
    connection carries exactly one JSON frame and is handled serially.
    """

    def __init__(self, observer: SignedTraceObserver, path: Path) -> None:
        if not isinstance(observer, SignedTraceObserver):
            raise ValueError("observer_socket_requires_signed_observer")
        self._observer = observer
        self._path = path.resolve()
        self._capability = secrets.token_urlsafe(32)
        self._server: _SignedTraceSocketServer | None = None
        self._thread: threading.Thread | None = None
        self._identity: tuple[int, int] | None = None

    @property
    def endpoint(self) -> SignedTraceSocketEndpoint:
        if self._server is None:
            raise RuntimeError("observer_socket_not_started")
        return SignedTraceSocketEndpoint(str(self._path), self._capability)

    def start(self) -> SignedTraceSocketEndpoint:
        if self._server is not None:
            raise RuntimeError("observer_socket_already_started")
        encoded_path = os.fsencode(self._path)
        if len(encoded_path) > 104:
            raise ValueError("observer_socket_path_too_long")
        parent = self._path.parent
        try:
            parent_stat = os.stat(parent)
        except OSError:
            raise ValueError("observer_socket_parent_unavailable") from None
        if (
            not stat.S_ISDIR(parent_stat.st_mode)
            or parent_stat.st_uid != os.getuid()
            or parent_stat.st_mode & 0o022
            or self._path.exists()
        ):
            raise ValueError("observer_socket_path_unsafe")
        server: _SignedTraceSocketServer | None = None
        bind_attempted = False
        try:
            bind_attempted = True
            server = _SignedTraceSocketServer(self._path, self._observer, self._capability)
            identity = os.lstat(self._path)
            if not stat.S_ISSOCK(identity.st_mode) or identity.st_uid != os.getuid():
                raise ValueError("observer_socket_path_unsafe")
            self._identity = (identity.st_dev, identity.st_ino)
            os.chmod(self._path, 0o600)
            current = os.lstat(self._path)
            if (
                not stat.S_ISSOCK(current.st_mode)
                or current.st_uid != os.getuid()
                or (current.st_dev, current.st_ino) != self._identity
            ):
                raise ValueError("observer_socket_path_unsafe")
        except (OSError, ValueError):
            if server is not None:
                server.server_close()
            if bind_attempted and self._identity is None:
                self._remove_failed_socket()
            self._remove_socket()
            raise
        assert server is not None
        self._server = server
        self._identity = (identity.st_dev, identity.st_ino)
        self._thread = threading.Thread(
            target=server.serve_forever,
            kwargs={"poll_interval": 0.1},
            name="plenger-observer-socket",
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
                and (current.st_dev, current.st_ino) == self._identity
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

    def __enter__(self) -> SignedTraceObserverSocket:
        self.start()
        return self

    def __exit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
        self.close()
