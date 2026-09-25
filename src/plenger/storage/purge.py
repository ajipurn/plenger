"""Explicit, project-scoped deletion of plenger's private storage."""

import hashlib
import os
import secrets
import stat
from pathlib import Path

from plenger.services.workspace import WorkspaceError, private_directory_name, root_fd
from plenger.storage.locking import runtime_lock_in_directory

_LOCK_FILES = frozenset({"worker.lock", "migration.lock", "server.lock"})


def _project_identity(root: Path) -> str:
    return hashlib.sha256(str(root.resolve()).encode()).hexdigest()


def _open_private(root: Path) -> int | None:
    parent = root_fd(root)
    try:
        try:
            private = os.open(
                private_directory_name(parent),
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=parent,
            )
        except FileNotFoundError:
            return None
        info = os.fstat(private)
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o700
        ):
            os.close(private)
            raise WorkspaceError("private_directory_permissions")
        return private
    finally:
        os.close(parent)


def _remove_entry(directory: int, name: str) -> int:
    if not name or name in {".", ".."} or "/" in name or "\\" in name:
        raise WorkspaceError("invalid_private_storage_entry")
    info = os.stat(name, dir_fd=directory, follow_symlinks=False)
    if stat.S_ISLNK(info.st_mode) or stat.S_ISREG(info.st_mode):
        os.unlink(name, dir_fd=directory)
        return 1
    if not stat.S_ISDIR(info.st_mode):
        raise WorkspaceError("unsafe_private_storage_entry")
    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
    try:
        opened = os.fstat(child)
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise WorkspaceError("private_storage_changed")
        removed = 0
        with os.scandir(child) as entries:
            for entry in entries:
                removed += _remove_entry(child, entry.name)
        current = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            raise WorkspaceError("private_storage_changed")
        os.rmdir(name, dir_fd=directory)
        return removed + 1
    finally:
        os.close(child)


def delete_project_storage(root: Path, confirmation: str) -> dict[str, int | str]:
    """Delete only ``.plenger`` data after an exact project-ID confirmation.

    Runtime lock files remain in the private directory so a concurrent process
    cannot recreate a lock path while this operation is releasing its locks.
    They contain no project metadata or evidence.
    """

    identity = _project_identity(root)
    if not isinstance(confirmation, str) or not confirmation:
        raise ValueError("project_storage_confirmation_required")
    if not secrets.compare_digest(confirmation, identity):
        raise ValueError("project_storage_confirmation_mismatch")
    if not hasattr(os, "getuid"):
        raise WorkspaceError("project_storage_delete_unsupported")
    private = _open_private(root)
    if private is None:
        return {"status": "not_found", "project_id": identity, "removed_entries": 0}
    removed = 0
    try:
        # Keep all control-plane locks while removing every data entry.
        with runtime_lock_in_directory(private, "migration.lock", blocking=False):
            with runtime_lock_in_directory(private, "worker.lock", blocking=False):
                with runtime_lock_in_directory(private, "server.lock", blocking=False):
                    with os.scandir(private) as entries:
                        for entry in entries:
                            if entry.name not in _LOCK_FILES:
                                removed += _remove_entry(private, entry.name)
    finally:
        os.close(private)
    return {"status": "deleted", "project_id": identity, "removed_entries": removed}


__all__ = ["delete_project_storage"]
