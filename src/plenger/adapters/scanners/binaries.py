"""Content identity and version probes for managed host scanner binaries."""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import threading
from pathlib import Path

VERSION_PROBE_TIMEOUT_SECONDS = 10
VERSION_PROBE_ATTEMPTS = 2

FileIdentity = tuple[str, int, int, int, int, int]
_IDENTITY_CACHE_LIMIT = 64
_identity_cache_lock = threading.Lock()
_binary_hash_cache: dict[FileIdentity, str] = {}
_version_cache: dict[FileIdentity, str] = {}


def file_identity(path: Path) -> FileIdentity | None:
    """Identity that changes whenever file content could have changed.

    ``st_ctime_ns`` cannot be set by ordinary callers, so a rewrite that restores
    size and mtime still produces a different identity.
    """

    try:
        info = os.stat(path)
    except OSError:
        return None
    return (
        str(path),
        info.st_dev,
        info.st_ino,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def _remember(cache: dict[FileIdentity, str], key: FileIdentity, value: str) -> None:
    with _identity_cache_lock:
        if len(cache) >= _IDENTITY_CACHE_LIMIT:
            cache.pop(next(iter(cache)))
        cache[key] = value


def hash_binary(path: Path) -> str:
    before = file_identity(path)
    if before is not None:
        with _identity_cache_lock:
            cached = _binary_hash_cache.get(before)
        if cached is not None:
            return cached
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            hasher.update(chunk)
    value = hasher.hexdigest()
    if before is not None and file_identity(path) == before:
        _remember(_binary_hash_cache, before, value)
    return value


def _parse_version_output(raw: bytes) -> str | None:
    output = raw.decode("utf-8", errors="replace").strip()
    if not output:
        return None
    first_line = output.splitlines()[0].strip()
    for prefix in ("osv-scanner version: ", "Version: "):
        if first_line.startswith(prefix):
            return first_line.removeprefix(prefix)
    return first_line


def version_probe(binary: str | Path) -> str | None:
    """Read a bounded version string from a managed binary or allowed name."""

    identity: FileIdentity | None = None
    if isinstance(binary, Path):
        if not binary.is_file():
            return None
        executable = str(binary)
        identity = file_identity(binary)
        if identity is not None:
            with _identity_cache_lock:
                cached = _version_cache.get(identity)
            if cached is not None:
                return cached
    else:
        if binary not in {"semgrep", "osv-scanner", "trivy"}:
            raise ValueError("unsupported_scanner_binary")
        resolved = shutil.which(binary)
        if not resolved:
            return None
        executable = resolved
    for attempt in range(VERSION_PROBE_ATTEMPTS):
        try:
            result = subprocess.run(
                [executable, "--version"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                env={"PATH": "/usr/local/bin:/usr/bin:/bin"},
                timeout=VERSION_PROBE_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired:
            if attempt + 1 < VERSION_PROBE_ATTEMPTS:
                continue
            return None
        except OSError:
            return None
        if result.returncode != 0:
            return None
        version = _parse_version_output(result.stdout[:4096])
        if (
            version is not None
            and identity is not None
            and isinstance(binary, Path)
            and file_identity(binary) == identity
        ):
            _remember(_version_cache, identity, version)
        return version
    return None
