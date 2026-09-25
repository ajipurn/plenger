"""Location, fingerprint and freshness of the provisioned offline OSV database."""

from __future__ import annotations

import hashlib
import os
import stat
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

from plenger.services.scanners.manifest import MAX_DATABASE_BYTES, ManagedScanner, open_private_dir
from plenger.services.workspace import WorkspaceError, private_directory_name, root_fd
from plenger.storage.runs import digest

DATABASE_MAX_AGE = timedelta(days=7)


def database_home(root: Path, *, create: bool) -> Path | None:
    parent = root_fd(root)
    try:
        private_name = private_directory_name(parent)
    finally:
        os.close(parent)
    private = open_private_dir(root, create=create)
    if private is None:
        return None
    scanners = -1
    database = -1
    try:
        if create:
            try:
                os.mkdir("scanners", 0o700, dir_fd=private)
            except FileExistsError:
                pass
        try:
            scanners = os.open(
                "scanners", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=private
            )
        except FileNotFoundError:
            return None
        scanners_info = os.fstat(scanners)
        if scanners_info.st_uid != os.getuid() or stat.S_IMODE(scanners_info.st_mode) != 0o700:
            raise WorkspaceError("unsafe_scanner_runtime")
        if create:
            try:
                os.mkdir("osv", 0o700, dir_fd=scanners)
            except FileExistsError:
                pass
        try:
            database = os.open("osv", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=scanners)
        except FileNotFoundError:
            return None
        database_info = os.fstat(database)
        if database_info.st_uid != os.getuid() or stat.S_IMODE(database_info.st_mode) != 0o700:
            raise WorkspaceError("unsafe_scanner_runtime")
        return root.resolve() / private_name / "scanners" / "osv"
    finally:
        if database >= 0:
            os.close(database)
        if scanners >= 0:
            os.close(scanners)
        os.close(private)


_fingerprint_cache_lock = threading.Lock()
_fingerprint_cache: dict[tuple[object, ...], tuple[str, int]] = {}


def _database_signature(home: Path) -> tuple[object, ...] | None:
    """Cheap stat-only signature; any content change alters at least ctime."""

    entries: list[tuple[str, int, int, int, int, int]] = []
    try:
        for current, directories, filenames in os.walk(home, followlinks=False):
            for name in [*directories, *filenames]:
                if (Path(current) / name).is_symlink():
                    return None
            for name in filenames:
                info = os.stat(Path(current) / name, follow_symlinks=False)
                entries.append(
                    (
                        (Path(current) / name).relative_to(home).as_posix(),
                        info.st_dev,
                        info.st_ino,
                        info.st_size,
                        info.st_mtime_ns,
                        info.st_ctime_ns,
                    )
                )
                if len(entries) > 10000:
                    return None
    except OSError:
        return None
    return (str(home), *sorted(entries))


def database_fingerprint(home: Path) -> tuple[str, int] | None:
    """Hash the provisioned database, reusing the result while no file changed."""

    if not home.is_dir():
        return None
    signature = _database_signature(home)
    if signature is not None:
        with _fingerprint_cache_lock:
            cached = _fingerprint_cache.get(signature)
        if cached is not None:
            return cached
    result = _hash_database(home)
    if result is not None and signature is not None and _database_signature(home) == signature:
        with _fingerprint_cache_lock:
            _fingerprint_cache.clear()
            _fingerprint_cache[signature] = result
    return result


def _hash_database(home: Path) -> tuple[str, int] | None:
    entries: list[tuple[str, int, str]] = []
    total = 0
    for current, directories, filenames in os.walk(home, followlinks=False):
        for name in [*directories, *filenames]:
            path = Path(current) / name
            if path.is_symlink():
                return None
        for name in sorted(filenames):
            path = Path(current) / name
            try:
                info = os.stat(path, follow_symlinks=False)
                if (
                    not stat.S_ISREG(info.st_mode)
                    or info.st_nlink != 1
                    or info.st_uid != os.getuid()
                ):
                    return None
                if info.st_size > MAX_DATABASE_BYTES or total + info.st_size > MAX_DATABASE_BYTES:
                    return None
                hasher = hashlib.sha256()
                with path.open("rb") as stream:
                    while chunk := stream.read(1024 * 1024):
                        hasher.update(chunk)
                after = os.stat(path, follow_symlinks=False)
                if (info.st_ino, info.st_size, info.st_mtime_ns) != (
                    after.st_ino,
                    after.st_size,
                    after.st_mtime_ns,
                ):
                    return None
            except OSError:
                return None
            relative = path.relative_to(home).as_posix()
            entries.append((relative, info.st_size, hasher.hexdigest()))
            if len(entries) > 10000:
                return None
            total += info.st_size
    if not entries:
        return None
    return digest(entries), total


def database_status(root: Path, entry: ManagedScanner) -> tuple[str, str, dict[str, str]]:
    if entry.database is None:
        return "unavailable", "osv_database_not_provisioned", {}
    home = database_home(root, create=False)
    actual = database_fingerprint(home) if home else None
    if actual is None:
        return "unavailable", "osv_database_missing_or_unsafe", {}
    if actual != (entry.database.fingerprint, entry.database.size_bytes):
        return "unavailable", "osv_database_changed", {}
    try:
        provisioned_at = datetime.fromisoformat(entry.database.provisioned_at)
        if provisioned_at.tzinfo is None:
            raise ValueError
    except ValueError:
        return "unavailable", "osv_database_timestamp_invalid", {}
    age = datetime.now(UTC) - provisioned_at.astimezone(UTC)
    if age > DATABASE_MAX_AGE:
        return "unavailable", "osv_database_stale", {"age_days": str(max(age.days, 0))}
    return "ready", "osv_database_verified", {"age_days": str(max(age.days, 0))}
