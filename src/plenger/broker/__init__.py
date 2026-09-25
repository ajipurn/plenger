"""Bounded local/staging broker; callers provide a registered TargetSpec, never a URL."""

from __future__ import annotations

import errno
import http.client
import ipaddress
import json
import socket
import ssl
import threading
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from plenger.policy import redact
from plenger.policy.active import (
    BudgetSpec,
    PolicyViolation,
    TargetSpec,
    dispatch_url,
    is_public_address,
)


class BrokerError(RuntimeError):
    pass


class _PinnedHTTPConnection(http.client.HTTPConnection):
    """HTTP connection whose socket address is pinned without proxy inheritance."""

    def __init__(self, host: str, port: int, pinned_address: str, timeout: float) -> None:
        super().__init__(host, port, timeout=timeout)
        self._pinned_address = pinned_address

    def connect(self) -> None:
        if getattr(self, "_tunnel_host", None):
            raise OSError("http_proxy_tunnel_not_supported")
        try:
            self.sock = socket.create_connection((self._pinned_address, self.port), self.timeout)
        except BaseException:
            self.close()
            raise


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection whose socket address is pinned without changing SNI."""

    def __init__(self, host: str, port: int, pinned_address: str, timeout: float) -> None:
        context = ssl.create_default_context()
        super().__init__(host, port, timeout=timeout, context=context)
        self._plenger_context = context
        self._pinned_address = pinned_address

    def connect(self) -> None:
        if getattr(self, "_tunnel_host", None):
            raise OSError("https_proxy_tunnel_not_supported")
        try:
            self.sock = socket.create_connection((self._pinned_address, self.port), self.timeout)
            self.sock = self._plenger_context.wrap_socket(self.sock, server_hostname=self.host)
        except BaseException:
            self.close()
            raise


BODY_EXCERPT_CHARACTERS = 2000


@dataclass(frozen=True)
class DispatchOutcome:
    """One bounded target response.

    ``body_excerpt`` is the redacted, display-sized excerpt. ``body`` is the complete
    decoded response (bounded by ``max_response_bytes``) and exists only so the
    confined worker can evaluate the fixed case before redaction or truncation can
    hide a forbidden marker. It is never persisted or included in reports.
    """

    attempt: int
    status_code: int
    body_excerpt: str
    response_truncated: bool
    redirect_received: bool
    body: str = field(default="", repr=False)


def body_excerpt(body: str) -> str:
    """Return the redacted excerpt that is safe to show or store."""

    return str(redact(body))[:BODY_EXCERPT_CHARACTERS]


def resolve_target_addresses(
    target: TargetSpec,
) -> tuple[ipaddress.IPv4Address | ipaddress.IPv6Address, ...]:
    """Resolve and validate the complete address set for an approved target."""

    parsed = urlsplit(target.base_url)
    if not parsed.hostname:
        raise ValueError("invalid_target_origin")
    port = parsed.port or 443
    try:
        addresses = {
            item[4][0]
            for item in socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
        }
    except OSError:
        raise ValueError("target_dns_failed") from None
    if not addresses:
        raise ValueError("target_dns_empty")
    try:
        parsed_addresses = tuple(
            sorted(
                (ipaddress.ip_address(address) for address in addresses),
                key=lambda address: (address.version, int(address)),
            )
        )
    except ValueError:
        raise ValueError("target_dns_invalid") from None
    if target.environment == "local":
        if not all(address.is_loopback for address in parsed_addresses):
            raise ValueError("target_address_not_loopback")
    elif not all(is_public_address(address) for address in parsed_addresses):
        raise ValueError("target_address_not_public")
    return parsed_addresses


@dataclass
class RequestBroker:
    target: TargetSpec
    budget: BudgetSpec
    _reserved: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _cancelled: threading.Event = field(default_factory=threading.Event)
    _slots: threading.BoundedSemaphore = field(init=False)

    def __post_init__(self) -> None:
        self._slots = threading.BoundedSemaphore(self.budget.concurrency)

    def cancel(self) -> None:
        with self._lock:
            self._cancelled.set()

    def stats(self) -> dict[str, Any]:
        with self._lock:
            return {"reserved_attempts": self._reserved, "cancelled": self._cancelled.is_set()}

    def _reserve(self) -> int:
        with self._lock:
            if self._cancelled.is_set():
                raise BrokerError("cancelled_before_dispatch")
            if self._reserved >= self.budget.max_attempts:
                raise BrokerError("budget_exhausted")
            self._reserved += 1
            return self._reserved

    def _resolved_addresses(self) -> tuple[ipaddress.IPv4Address | ipaddress.IPv6Address, ...]:
        try:
            parsed_addresses = resolve_target_addresses(self.target)
        except ValueError as exc:
            raise BrokerError(str(exc)) from None
        if self.target.allowed_ips and tuple(self.target.allowed_ips) != tuple(
            str(address) for address in parsed_addresses
        ):
            raise BrokerError("target_address_set_changed")
        return parsed_addresses

    @staticmethod
    def _phase_timeout(timeout: float, deadline: float | None) -> float:
        if deadline is None:
            return timeout
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise BrokerError("wall_time_exhausted")
        return min(timeout, remaining)

    def _staging_endpoint(self) -> tuple[str, int, str]:
        parsed = urlsplit(self.target.base_url)
        if not parsed.hostname:
            raise BrokerError("invalid_target_origin")
        return parsed.hostname, parsed.port or 443, str(self._resolved_addresses()[0])

    def _read_socket_response(
        self,
        response: http.client.HTTPResponse,
        attempt: int,
        timeout: float,
        deadline: float | None,
    ) -> DispatchOutcome:
        content = bytearray()
        reader = getattr(response, "read1", response.read)
        response_file = getattr(response, "fp", None)
        response_raw = getattr(response_file, "raw", None)
        response_socket = getattr(response_raw, "_sock", None)
        while True:
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise BrokerError("wall_time_exhausted")
                read_timeout = min(timeout, remaining)
            else:
                read_timeout = timeout
            if response_socket is not None:
                try:
                    response_socket.settimeout(read_timeout)
                except OSError as exc:
                    if exc.errno != errno.EBADF:
                        raise
                    # Some Python/http.client combinations close the raw socket
                    # once a fixed-length response is fully buffered.  The
                    # response reader remains usable, but the closed descriptor
                    # cannot carry a timeout anymore.
                    response_socket = None
                except ValueError:
                    # Some Python/http.client combinations close the raw socket
                    # once a fixed-length response is fully buffered.  The
                    # response reader remains usable, but the closed descriptor
                    # cannot carry a timeout anymore.
                    response_socket = None
            chunk = reader(min(65536, self.target.max_response_bytes + 1 - len(content)))
            if not chunk:
                break
            content.extend(chunk)
            if len(content) > self.target.max_response_bytes:
                return DispatchOutcome(
                    attempt=attempt,
                    status_code=response.status,
                    body_excerpt="",
                    response_truncated=True,
                    redirect_received=response.status in {301, 302, 303, 307, 308},
                )
        if deadline is not None and time.monotonic() >= deadline:
            raise BrokerError("wall_time_exhausted")
        body = bytes(content).decode("utf-8", errors="replace")
        return DispatchOutcome(
            attempt=attempt,
            status_code=response.status,
            body_excerpt=body_excerpt(body),
            response_truncated=False,
            redirect_received=response.status in {301, 302, 303, 307, 308},
            body=body,
        )

    def _dispatch_staging(
        self,
        method: str,
        path: str,
        encoded: bytes,
        attempt: int,
        timeout: float,
        deadline: float | None,
    ) -> DispatchOutcome:
        host, port, pinned_address = self._staging_endpoint()
        host_header = f"[{host}]" if ":" in host else host
        if port != 443:
            host_header += ":" + str(port)
        connection: _PinnedHTTPSConnection | None = None
        response: http.client.HTTPResponse | None = None
        try:
            connection = _PinnedHTTPSConnection(
                host, port, pinned_address, self._phase_timeout(timeout, deadline)
            )
            connection.request(
                method,
                path,
                body=encoded,
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "Connection": "close",
                    "Host": host_header,
                    "Accept-Encoding": "identity",
                },
            )
            if deadline is not None and getattr(connection, "sock", None) is not None:
                connection.sock.settimeout(self._phase_timeout(timeout, deadline))
            response = connection.getresponse()
            return self._read_socket_response(response, attempt, timeout, deadline)
        except (http.client.HTTPException, OSError, ssl.SSLError, TimeoutError):
            if deadline is not None and time.monotonic() >= deadline:
                raise BrokerError("wall_time_exhausted") from None
            raise BrokerError("target_request_failed") from None
        finally:
            if response is not None:
                close = getattr(response, "close", None)
                if callable(close):
                    close()
            if connection is not None:
                connection.close()

    def _dispatch_local(
        self,
        method: str,
        path: str,
        encoded: bytes,
        attempt: int,
        timeout: float,
        deadline: float | None,
    ) -> DispatchOutcome:
        parsed = urlsplit(self.target.base_url)
        if not parsed.hostname or parsed.port is None:
            raise BrokerError("invalid_target_origin")
        pinned_address = str(self._resolved_addresses()[0])
        connection: _PinnedHTTPConnection | None = None
        response: http.client.HTTPResponse | None = None
        try:
            connection = _PinnedHTTPConnection(
                parsed.hostname,
                parsed.port,
                pinned_address,
                self._phase_timeout(timeout, deadline),
            )
            connection.request(
                method,
                path,
                body=encoded,
                headers={
                    "Accept": "application/json",
                    "Accept-Encoding": "identity",
                    "Content-Type": "application/json",
                    "Connection": "close",
                    "Host": parsed.netloc,
                },
            )
            if deadline is not None and getattr(connection, "sock", None) is not None:
                connection.sock.settimeout(self._phase_timeout(timeout, deadline))
            response = connection.getresponse()
            return self._read_socket_response(response, attempt, timeout, deadline)
        except (http.client.HTTPException, OSError, ssl.SSLError, TimeoutError):
            if deadline is not None and time.monotonic() >= deadline:
                raise BrokerError("wall_time_exhausted") from None
            raise BrokerError("target_request_failed") from None
        finally:
            if response is not None:
                response.close()
            if connection is not None:
                connection.close()

    def dispatch(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        deadline: float | None = None,
    ) -> DispatchOutcome:
        try:
            dispatch_url(self.target, method, path)
        except PolicyViolation as exc:
            raise BrokerError(str(exc)) from None
        try:
            encoded = json.dumps(payload or {}, separators=(",", ":")).encode()
        except (TypeError, ValueError):
            raise BrokerError("invalid_request_payload") from None
        if len(encoded) > 32 * 1024:
            raise BrokerError("request_too_large")
        timeout: float = self.budget.request_timeout_seconds
        if deadline is not None:
            timeout = min(timeout, max(0.001, deadline - time.monotonic()))
            if deadline <= time.monotonic():
                raise BrokerError("wall_time_exhausted")
        if not self._slots.acquire(timeout=timeout):
            raise BrokerError("concurrency_limit")
        try:
            if deadline is not None and deadline <= time.monotonic():
                raise BrokerError("wall_time_exhausted")
            attempt = self._reserve()
            with self._lock:
                if self._cancelled.is_set():
                    raise BrokerError("cancelled_before_dispatch")
            if self.target.environment == "staging":
                return self._dispatch_staging(method, path, encoded, attempt, timeout, deadline)
            # The original URL is only used to validate the registered scope. The
            # socket connects to the pinned literal IP, with proxy inheritance off.
            return self._dispatch_local(method, path, encoded, attempt, timeout, deadline)
        finally:
            self._slots.release()
