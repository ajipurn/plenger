import errno
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socket import AF_INET, AF_INET6, SOCK_STREAM
from types import SimpleNamespace

import pytest

from plenger.broker.dispatch import BrokerError, RequestBroker
from plenger.broker.ipc import (
    UnixBrokerEndpoint,
    UnixBrokerServer,
    UnixSocketRequestBroker,
)
from plenger.policy.active import BudgetSpec, TargetSpec


class Handler(BaseHTTPRequestHandler):
    post_calls = 0
    post_calls_lock = threading.Lock()

    def do_GET(self):  # noqa: N802
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "http://169.254.169.254/latest")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path == "/fixed-length":
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
            return
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def do_POST(self):  # noqa: N802
        with type(self).post_calls_lock:
            type(self).post_calls += 1
        length = int(self.headers.get("Content-Length", "0"))
        payload = self.rfile.read(length)
        if self.path == "/trickle":
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"a")
            self.wfile.flush()
            time.sleep(0.5)
            self.wfile.write(b"b")
            self.wfile.flush()
            return
        if self.path == "/delayed-trickle":
            time.sleep(0.2)
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"a")
            self.wfile.flush()
            time.sleep(0.5)
            self.wfile.write(b"b")
            self.wfile.flush()
            return
        if self.path == "/slow":
            time.sleep(1.2)
        time.sleep(0.05)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        del format, args


@pytest.fixture
def server():
    instance = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=instance.serve_forever, daemon=True)
    thread.start()
    try:
        yield instance.server_address[1]
    finally:
        instance.shutdown()
        thread.join(timeout=2)
        instance.server_close()


def make_target(port, paths=None):
    return TargetSpec(
        target_ref="fixture",
        base_url=f"http://127.0.0.1:{port}",
        environment="local",
        allowed_paths=paths or ["/echo", "/redirect"],
        allowed_methods=["GET", "POST"],
        max_response_bytes=1024,
    )


def test_active_runner_capability_fails_closed_without_posix_unix_socket(monkeypatch):
    import plenger.broker.ipc as ipc

    monkeypatch.setattr(ipc.os, "name", "nt")
    assert ipc.active_runner_capability() == {
        "status": "unavailable",
        "reason": "posix_unix_socket_required",
    }


def test_broker_pins_loopback_redacts_response_and_does_not_follow_redirect(server):
    broker = RequestBroker(make_target(server), BudgetSpec(max_attempts=3))
    response = broker.dispatch("POST", "/echo", {"value": "sk-secret-SYNTHETIC0123456789"})
    assert response.status_code == 200
    assert "SYNTHETIC" not in response.body_excerpt
    redirect = broker.dispatch("GET", "/redirect")
    assert redirect.redirect_received and redirect.status_code == 302


def test_broker_connects_to_resolved_loopback_ip_without_using_proxy_environment(
    server, monkeypatch
):
    target = TargetSpec(
        target_ref="fixture",
        base_url=f"http://localhost:{server}",
        environment="local",
        allowed_paths=["/echo"],
        allowed_methods=["POST"],
        allowed_ips=["127.0.0.1"],
        max_response_bytes=1024,
    )
    resolutions = []

    def resolve(host, port, *args, **kwargs):
        del args, kwargs
        resolutions.append((host, port))
        if host not in {"localhost", "127.0.0.1"}:
            pytest.fail(f"unexpected DNS lookup for {host}")
        return [(AF_INET, SOCK_STREAM, 6, "", ("127.0.0.1", port))]

    monkeypatch.setattr("plenger.broker.dispatch.socket.getaddrinfo", resolve)
    for key in ("http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        monkeypatch.setenv(key, "http://192.0.2.1:9")

    outcome = RequestBroker(target, BudgetSpec(max_attempts=1)).dispatch("POST", "/echo")

    assert outcome.status_code == 200
    assert resolutions == [("localhost", server), ("127.0.0.1", server)]


def test_broker_reads_fixed_length_response_when_socket_is_already_closed(server):
    broker = RequestBroker(make_target(server, ["/fixed-length"]), BudgetSpec(max_attempts=1))
    response = broker.dispatch("GET", "/fixed-length")
    assert response.status_code == 200
    assert response.body_excerpt == "ok"


def test_broker_does_not_ignore_unrelated_socket_timeout_error(server):
    class BrokenSocket:
        def settimeout(self, value):
            del value
            raise OSError(errno.EIO, "synthetic socket failure")

    class Response:
        status = 200
        fp = SimpleNamespace(raw=SimpleNamespace(_sock=BrokenSocket()))

        def read(self, amount):
            del amount
            return b""

        def read1(self, amount):
            del amount
            return b""

    broker = RequestBroker(make_target(server, ["/fixed-length"]), BudgetSpec(max_attempts=1))
    with pytest.raises(OSError) as error:
        broker._read_socket_response(Response(), 1, 1.0, None)
    assert error.value.errno == errno.EIO


def test_broker_enforces_path_cancel_and_attempt_budget(server):
    broker = RequestBroker(
        make_target(server, ["/echo"]), BudgetSpec(max_attempts=2, concurrency=1)
    )
    with pytest.raises(BrokerError, match="target_scope_denied"):
        broker.dispatch("GET", "/redirect")
    outcomes = []
    errors = []

    def call():
        try:
            outcomes.append(broker.dispatch("POST", "/echo", {"value": "x"}))
        except BrokerError as exc:
            errors.append(str(exc))

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: call(), range(4)))
    assert len(outcomes) == 2
    assert "budget_exhausted" in errors
    assert broker.stats()["reserved_attempts"] == 2
    broker.cancel()
    with pytest.raises(BrokerError, match="cancelled_before_dispatch"):
        broker.dispatch("POST", "/echo", {"value": "x"})


def test_broker_pins_public_staging_dns_and_preserves_hostname(monkeypatch):
    target = TargetSpec(
        target_ref="staging-fixture",
        base_url="https://staging.example.test",
        environment="staging",
        allowed_paths=["/echo"],
        allowed_methods=["POST"],
        allowed_ips=["93.184.216.34"],
        max_response_bytes=1024,
    )
    calls = {}

    class Response:
        status = 200

        def __init__(self):
            self.read_once = True

        def read(self, limit):
            assert 1 <= limit <= 1025
            if not self.read_once:
                return b""
            self.read_once = False
            return b'{"output_text":"ok"}'

    class Connection:
        def __init__(self, host, port, pinned_address, timeout):
            calls["connection"] = (host, port, pinned_address, timeout)

        def request(self, method, path, *, body, headers):
            calls["request"] = (method, path, body, headers)

        def getresponse(self):
            return Response()

        def close(self):
            calls["closed"] = True

    monkeypatch.setattr("plenger.broker.dispatch._PinnedHTTPSConnection", Connection)
    monkeypatch.setattr(
        "plenger.broker.dispatch.socket.getaddrinfo",
        lambda host, port, type: [(AF_INET, SOCK_STREAM, 6, "", ("93.184.216.34", port))],
    )
    broker = RequestBroker(target, BudgetSpec(max_attempts=1))
    outcome = broker.dispatch("POST", "/echo", {"value": "synthetic"})
    assert outcome.status_code == 200
    assert outcome.body_excerpt == '{"output_text":"ok"}'
    assert calls["connection"][:3] == ("staging.example.test", 443, "93.184.216.34")
    method, path, body, headers = calls["request"]
    assert method == "POST" and path == "/echo" and body == b'{"value":"synthetic"}'
    assert headers["Host"] == "staging.example.test"
    assert calls["closed"]


def test_broker_rejects_dns_set_change_after_plan_binding(monkeypatch):
    target = TargetSpec(
        target_ref="staging-fixture",
        base_url="https://staging.example.test",
        environment="staging",
        allowed_paths=["/echo"],
        allowed_methods=["POST"],
        allowed_ips=["93.184.216.34"],
    )
    monkeypatch.setattr(
        "plenger.broker.dispatch.socket.getaddrinfo",
        lambda host, port, type: [(AF_INET, SOCK_STREAM, 6, "", ("1.1.1.1", port))],
    )
    with pytest.raises(BrokerError, match="target_address_set_changed"):
        RequestBroker(target, BudgetSpec(max_attempts=1)).dispatch("POST", "/echo", {})


@pytest.mark.parametrize(
    "changed_records",
    [
        [(AF_INET, SOCK_STREAM, 6, "", ("93.184.216.34", 443))],
        [
            (AF_INET, SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
            (AF_INET, SOCK_STREAM, 6, "", ("1.1.1.1", 443)),
            (AF_INET6, SOCK_STREAM, 6, "", ("2606:4700:4700::1111", 443, 0, 0)),
        ],
        [
            (AF_INET, SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
            (AF_INET6, SOCK_STREAM, 6, "", ("2606:4700:4700::1001", 443, 0, 0)),
        ],
    ],
    ids=["removed-address", "added-address", "replaced-ipv6-address"],
)
def test_broker_revalidates_complete_dns_set_before_every_dispatch(monkeypatch, changed_records):
    target = TargetSpec(
        target_ref="staging-fixture",
        base_url="https://staging.example.test",
        environment="staging",
        allowed_paths=["/echo"],
        allowed_methods=["POST"],
        allowed_ips=["2606:4700:4700::1111", "93.184.216.34"],
        max_response_bytes=1024,
    )
    initial_records = [
        (AF_INET6, SOCK_STREAM, 6, "", ("2606:4700:4700::1111", 443, 0, 0)),
        (AF_INET, SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
    ]
    answers = iter([initial_records, changed_records])
    monkeypatch.setattr(
        "plenger.broker.dispatch.socket.getaddrinfo",
        lambda host, port, type: next(answers),
    )
    connections = []

    class Response:
        status = 200

        def __init__(self):
            self.returned = False

        def read(self, limit):
            assert limit in {1023, 1025}
            if self.returned:
                return b""
            self.returned = True
            return b"ok"

    class Connection:
        def __init__(self, host, port, pinned_address, timeout):
            del timeout
            connections.append((host, port, pinned_address))

        def request(self, method, path, *, body, headers):
            del method, path, body, headers

        def getresponse(self):
            return Response()

        def close(self):
            pass

    monkeypatch.setattr("plenger.broker.dispatch._PinnedHTTPSConnection", Connection)
    broker = RequestBroker(target, BudgetSpec(max_attempts=2))

    assert broker.dispatch("POST", "/echo", {}).status_code == 200
    assert connections == [("staging.example.test", 443, "93.184.216.34")]
    with pytest.raises(BrokerError, match="target_address_set_changed"):
        broker.dispatch("POST", "/echo", {})
    assert len(connections) == 1


@pytest.mark.parametrize(
    ("family", "unsafe_address"),
    [
        (AF_INET, "127.0.0.1"),
        (AF_INET, "169.254.169.254"),
        (AF_INET6, "::1"),
        (AF_INET6, "fd00::1"),
        (AF_INET6, "fe80::1"),
        (AF_INET, "100.64.0.1"),
        (AF_INET6, "2002:a00:1::1"),
        (AF_INET6, "64:ff9b:1::a00:1"),
        (AF_INET6, "64:ff9b::a00:1"),
        (AF_INET6, "2001:0:4136:e378::1"),
        (AF_INET6, "::ffff:10.0.0.1"),
    ],
    ids=[
        "ipv4-loopback",
        "ipv4-metadata",
        "ipv6-loopback",
        "ipv6-private",
        "ipv6-link-local",
        "ipv4-cgnat",
        "ipv6-6to4-private",
        "ipv6-local-nat64",
        "ipv6-nat64",
        "ipv6-teredo",
        "ipv6-mapped-private",
    ],
)
def test_broker_rejects_private_or_mixed_staging_dns(monkeypatch, family, unsafe_address):
    target = TargetSpec(
        target_ref="staging-fixture",
        base_url="https://staging.example.test",
        environment="staging",
        allowed_paths=["/echo"],
        allowed_methods=["GET"],
    )
    sockaddr = (unsafe_address, 443, 0, 0) if family == AF_INET6 else (unsafe_address, 443)
    monkeypatch.setattr(
        "plenger.broker.dispatch.socket.getaddrinfo",
        lambda host, port, type: [
            (AF_INET, SOCK_STREAM, 6, "", ("93.184.216.34", port)),
            (family, SOCK_STREAM, 6, "", sockaddr),
        ],
    )
    with pytest.raises(BrokerError, match="target_address_not_public"):
        RequestBroker(target, BudgetSpec(max_attempts=1)).dispatch("GET", "/echo")


@pytest.mark.parametrize(
    ("resolver_mode", "error"),
    [
        ("failure", "target_dns_failed"),
        ("empty", "target_dns_empty"),
        ("invalid", "target_dns_invalid"),
    ],
)
def test_broker_fails_closed_on_dns_resolution_errors(monkeypatch, resolver_mode, error):
    target = TargetSpec(
        target_ref="staging-fixture",
        base_url="https://staging.example.test",
        environment="staging",
        allowed_paths=["/echo"],
        allowed_methods=["GET"],
    )

    def resolve(host, port, type):
        del host, port, type
        if resolver_mode == "failure":
            raise OSError("synthetic DNS failure")
        if resolver_mode == "empty":
            return []
        return [(AF_INET, SOCK_STREAM, 6, "", ("not-an-ip", 443))]

    monkeypatch.setattr("plenger.broker.dispatch.socket.getaddrinfo", resolve)
    with pytest.raises(BrokerError, match=error):
        RequestBroker(target, BudgetSpec(max_attempts=1)).dispatch("GET", "/echo")


def test_broker_rejects_dispatch_after_wall_deadline(server):
    broker = RequestBroker(make_target(server), BudgetSpec(max_attempts=1))
    with pytest.raises(BrokerError, match="wall_time_exhausted"):
        broker.dispatch("GET", "/echo", deadline=time.monotonic() - 1)
    assert broker.stats()["reserved_attempts"] == 0


def test_broker_enforces_absolute_wall_deadline_during_response_read(server):
    Handler.post_calls = 0
    broker = RequestBroker(
        make_target(server, ["/trickle"]), BudgetSpec(max_attempts=1, request_timeout_seconds=2)
    )
    started = time.monotonic()
    with pytest.raises(BrokerError, match="wall_time_exhausted"):
        broker.dispatch("POST", "/trickle", {"value": "x"}, deadline=time.monotonic() + 0.1)
    assert time.monotonic() - started < 0.4
    assert broker.stats()["reserved_attempts"] == 1
    assert Handler.post_calls == 1
    with pytest.raises(BrokerError, match="budget_exhausted"):
        broker.dispatch("POST", "/trickle", {"value": "x"})
    assert Handler.post_calls == 1


def test_broker_enforces_wall_deadline_after_response_headers(server):
    broker = RequestBroker(
        make_target(server, ["/delayed-trickle"]),
        BudgetSpec(max_attempts=1, request_timeout_seconds=2),
    )
    started = time.monotonic()
    with pytest.raises(BrokerError, match="wall_time_exhausted"):
        broker.dispatch(
            "POST", "/delayed-trickle", {"value": "x"}, deadline=time.monotonic() + 0.25
        )
    assert time.monotonic() - started < 0.4


def test_broker_carries_wall_deadline_into_connection_after_dns_resolution(monkeypatch):
    target = make_target(1, ["/echo"])
    calls = {}

    def slow_getaddrinfo(host, port, type):
        del host, port, type
        time.sleep(0.08)
        return [(AF_INET, SOCK_STREAM, 6, "", ("127.0.0.1", 1))]

    class Response:
        status = 200

        def read(self, limit):
            del limit
            if calls.get("read"):
                return b""
            calls["read"] = True
            return b"ok"

        def close(self):
            calls["response_closed"] = True

    class Connection:
        def __init__(self, host, port, pinned_address, timeout):
            calls["timeout"] = timeout
            calls["connection"] = (host, port, pinned_address)

        def request(self, method, path, *, body, headers):
            del method, path, body, headers

        def getresponse(self):
            return Response()

        def close(self):
            calls["closed"] = True

    monkeypatch.setattr("plenger.broker.dispatch.socket.getaddrinfo", slow_getaddrinfo)
    monkeypatch.setattr("plenger.broker.dispatch._PinnedHTTPConnection", Connection)
    broker = RequestBroker(target, BudgetSpec(max_attempts=1, request_timeout_seconds=2))

    outcome = broker.dispatch("POST", "/echo", {}, deadline=time.monotonic() + 0.2)

    assert outcome.status_code == 200
    assert 0 < calls["timeout"] < 0.16
    assert calls["connection"] == ("127.0.0.1", 1, "127.0.0.1")
    assert calls["closed"]


def test_broker_enforces_ten_attempt_budget_across_one_hundred_dispatchers(server):
    Handler.post_calls = 0
    broker = RequestBroker(
        make_target(server, ["/echo"]), BudgetSpec(max_attempts=10, concurrency=2)
    )

    def call(_index):
        try:
            broker.dispatch("POST", "/echo", {"index": _index})
            return "completed"
        except BrokerError as exc:
            return str(exc)

    with ThreadPoolExecutor(max_workers=100) as pool:
        results = list(pool.map(call, range(100)))
    assert results.count("completed") == 10
    assert Handler.post_calls == 10
    assert broker.stats()["reserved_attempts"] == 10
    assert results.count("budget_exhausted") == 90


def test_unix_socket_broker_is_capability_bound_and_cleans_up(server):
    target = make_target(server, ["/echo"])
    budget = BudgetSpec(max_attempts=2, concurrency=1)
    backend = RequestBroker(target, budget)
    with tempfile.TemporaryDirectory(prefix="plenger-broker-", dir="/tmp") as directory:
        socket_path = Path(directory) / "broker.sock"
        with UnixBrokerServer(backend, socket_path) as transport:
            endpoint = transport.endpoint
            assert socket_path.stat().st_mode & 0o777 == 0o600
            client = UnixSocketRequestBroker(endpoint, target, budget)
            outcome = client.dispatch("POST", "/echo", {"value": "sk-secret-SYNTHETIC0123456789"})
            assert outcome.status_code == 200
            assert "SYNTHETIC" not in outcome.body_excerpt
            assert client.stats()["reserved_attempts"] == 1

            wrong_capability = UnixSocketRequestBroker(
                UnixBrokerEndpoint(endpoint.path, "wrong-capability"), target, budget
            )
            with pytest.raises(BrokerError, match="broker_capability_invalid"):
                wrong_capability.stats()

            client.cancel()
            with pytest.raises(BrokerError, match="cancelled_before_dispatch"):
                client.dispatch("POST", "/echo", {"value": "x"})

        assert not socket_path.exists()


def test_unix_socket_broker_waits_for_bounded_target_response(server):
    target = make_target(server, ["/slow"])
    budget = BudgetSpec(max_attempts=1, request_timeout_seconds=2)
    backend = RequestBroker(target, budget)
    with tempfile.TemporaryDirectory(prefix="plenger-broker-", dir="/tmp") as directory:
        socket_path = Path(directory) / "broker.sock"
        with UnixBrokerServer(backend, socket_path) as transport:
            client = UnixSocketRequestBroker(transport.endpoint, target, budget)
            outcome = client.dispatch("POST", "/slow", {"value": "x"})
            assert outcome.status_code == 200


def test_unix_socket_broker_cleans_partial_bind_failure(server, monkeypatch):
    target = make_target(server, ["/echo"])
    budget = BudgetSpec(max_attempts=1)
    backend = RequestBroker(target, budget)
    with tempfile.TemporaryDirectory(prefix="plenger-broker-", dir="/tmp") as directory:
        socket_path = Path(directory) / "broker.sock"

        def fail_activate(_server):
            raise OSError("activation_failed")

        monkeypatch.setattr("plenger.broker.ipc._UnixBrokerServer.server_activate", fail_activate)
        with pytest.raises(OSError, match="activation_failed"):
            UnixBrokerServer(backend, socket_path).start()
        assert not socket_path.exists()


def test_unix_broker_delivers_complete_body_for_evaluation_but_redacts_excerpt(server):
    target = make_target(server, ["/echo"])
    budget = BudgetSpec(max_attempts=2, concurrency=1)
    backend = RequestBroker(target, budget)
    marker_payload = {"padding": "p" * 900, "leak": "secret: PLENGER_SYNTHETIC_DISCLOSURE_MARKER"}
    with tempfile.TemporaryDirectory(prefix="plenger-broker-", dir="/tmp") as directory:
        with UnixBrokerServer(backend, Path(directory) / "broker.sock") as transport:
            client = UnixSocketRequestBroker(transport.endpoint, target, budget)
            outcome = client.dispatch("POST", "/echo", marker_payload)
    assert "PLENGER_SYNTHETIC_DISCLOSURE_MARKER" in outcome.body
    assert "PLENGER_SYNTHETIC_DISCLOSURE_MARKER" not in outcome.body_excerpt
    assert "PLENGER_SYNTHETIC_DISCLOSURE_MARKER" not in repr(outcome)
