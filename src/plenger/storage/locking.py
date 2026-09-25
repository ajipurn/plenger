"""OS-released local locks; never break locks based on a target-provided PID."""

import fcntl
import os
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from plenger.services.workspace import WorkspaceError, private_directory_name, root_fd


class StoreBusy(RuntimeError):
    pass


@contextmanager
def runtime_lock_in_directory(
    private: int, name: str = "worker.lock", blocking: bool = False
) -> Iterator[None]:
    """Lock a control file beneath an already-open, validated private directory."""

    if name not in {"worker.lock", "migration.lock", "server.lock"}:
        raise ValueError("invalid_runtime_lock")
    info = os.fstat(private)
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise WorkspaceError("unsafe_runtime_directory")
    descriptor = -1
    try:
        descriptor = os.open(
            name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=private
        )
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
            raise WorkspaceError("unsafe_lock_file")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError:
            raise StoreBusy("project_worker_busy") from None
        yield
    finally:
        if descriptor >= 0:
            os.close(descriptor)


@contextmanager
def runtime_lock(root: Path, name: str = "worker.lock", blocking: bool = False) -> Iterator[None]:
    parent = root_fd(root)
    private = -1
    try:
        private = os.open(
            private_directory_name(parent),
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=parent,
        )
        with runtime_lock_in_directory(private, name, blocking):
            yield
    finally:
        if private >= 0:
            os.close(private)
        os.close(parent)
