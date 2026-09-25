"""A capability-bound broker process that owns one active run's target access."""

import multiprocessing
import secrets
import tempfile
import threading
from multiprocessing.connection import Connection
from multiprocessing.process import BaseProcess
from pathlib import Path
from typing import Any

from plenger.broker.dispatch import BrokerError, DispatchOutcome, RequestBroker
from plenger.broker.ipc import (
    UnixBrokerEndpoint,
    UnixSocketRequestBroker,
    _run_unix_broker_process,
)
from plenger.policy.active import BudgetSpec, TargetSpec


class ActiveJobBroker(RequestBroker):
    """Route one active run through a child-process, capability-bound broker."""

    def __init__(self, target: TargetSpec, budget: BudgetSpec) -> None:
        super().__init__(target, budget)
        self._temporary_directory = tempfile.TemporaryDirectory(prefix="plenger-active-broker-")
        socket_path = Path(self._temporary_directory.name) / "broker.sock"
        capability = secrets.token_urlsafe(32)
        self._process: BaseProcess | None = None
        self._closed = False
        self._transport_condition = threading.Condition()
        self._active_transport_calls = 0
        parent_ready: Connection | None = None
        child_ready: Connection | None = None
        try:
            context = multiprocessing.get_context("spawn")
            parent_ready, child_ready = context.Pipe(duplex=False)
            process_factory: Any = context.Process
            process = process_factory(
                target=_run_unix_broker_process,
                args=(str(socket_path), capability, target, budget, child_ready),
                name="plenger-active-broker",
                daemon=True,
            )
            self._process = process
            process.start()
            child_ready.close()
            if not parent_ready.poll(5.0):
                raise RuntimeError("broker_process_start_timeout")
            message = parent_ready.recv()
            if not isinstance(message, dict) or message.get("ok") is not True:
                raise RuntimeError("broker_process_start_failed")
            parent_ready.close()
            endpoint = UnixBrokerEndpoint(str(socket_path), capability)
            self._endpoint = endpoint
            self._client = UnixSocketRequestBroker(endpoint, target, budget)
        except BaseException:
            if parent_ready is not None:
                parent_ready.close()
            if child_ready is not None:
                child_ready.close()
            self._stop_process()
            self._temporary_directory.cleanup()
            raise

    @property
    def endpoint(self) -> UnixBrokerEndpoint:
        return self._endpoint

    @property
    def worker_pid(self) -> int | None:
        return None if self._process is None else self._process.pid

    def dispatch(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        deadline: float | None = None,
    ) -> DispatchOutcome:
        client = self._begin_transport_call()
        assert client is not None
        try:
            return client.dispatch(method, path, payload, deadline=deadline)
        finally:
            self._end_transport_call()

    def cancel(self) -> None:
        client = self._begin_transport_call(allow_closed=True)
        if client is None:
            return
        try:
            client.cancel()
        finally:
            self._end_transport_call()

    def stats(self) -> dict[str, Any]:
        client = self._begin_transport_call()
        assert client is not None
        try:
            return client.stats()
        finally:
            self._end_transport_call()

    def _begin_transport_call(
        self, *, allow_closed: bool = False
    ) -> UnixSocketRequestBroker | None:
        with self._transport_condition:
            if self._closed:
                if allow_closed:
                    return None
                raise BrokerError("broker_closed")
            self._active_transport_calls += 1
            return self._client

    def _end_transport_call(self) -> None:
        with self._transport_condition:
            self._active_transport_calls -= 1
            self._transport_condition.notify_all()

    def close(self) -> None:
        with self._transport_condition:
            if self._closed:
                return
            self._closed = True
            while self._active_transport_calls:
                self._transport_condition.wait()
        try:
            self._stop_process()
        finally:
            self._temporary_directory.cleanup()

    def _stop_process(self) -> None:
        process = self._process
        if process is None:
            return
        if process.pid is None:
            self._process = None
            return
        if process.is_alive():
            process.terminate()
        process.join(timeout=2)
        if process.is_alive():
            process.kill()
            process.join(timeout=2)
        self._process = None
