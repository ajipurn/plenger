"""Managed scanner setup, staging, and baseline orchestration.

Project configuration cannot select binaries, images, or grant network access.
The manifest in ``.plenger`` is written only by explicit setup commands and is
revalidated against the managed binary or digest-pinned image and the offline
OSV database before every baseline run.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import tempfile
import threading
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from pydantic import Field, ValidationError, field_validator, model_validator

from plenger.adapters.scanners import (
    SCANNER_CONTAINER_IMAGES,
    EngineName,
    ScannerExecutionError,
    ScannerOutputError,
    ScannerResult,
    ScannerUnavailable,
    _binary_hash,
    _bounded_process,
    _map_container_output,
    container_image_present,
    container_runtime_mode,
    container_user_available,
    container_version_probe,
    execute_scanner,
    plan_scanner,
    probe_optional_engines,
    pull_container_image,
    scanner_isolation_mode,
    unresolved_dependency_findings,
    version_probe,
)
from plenger.domain import StrictModel
from plenger.policy import redact
from plenger.services.workspace import (
    WorkspaceError,
    capture,
    load_config,
    private_directory_name,
    read_regular,
    root_fd,
)
from plenger.storage.locking import runtime_lock
from plenger.storage.runs import digest, now

SCANNER_NAMES: tuple[EngineName, ...] = ("semgrep", "osv", "trivy")
SCANNER_MANIFEST_FILE = "scanner-manifest.json"
MAX_MANIFEST_BYTES = 64 * 1024
MAX_DATABASE_BYTES = 512 * 1024 * 1024
DATABASE_MAX_AGE = timedelta(days=7)
_NPM_INPUT_FILES = frozenset(
    {"package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"}
)
_OSV_PROVISION_INPUTS = {
    "npm": _NPM_INPUT_FILES,
    "cargo": frozenset({"Cargo.toml", "Cargo.lock"}),
    "go": frozenset({"go.mod", "go.sum"}),
    "ruby": frozenset({"Gemfile", "Gemfile.lock"}),
    "composer": frozenset({"composer.json", "composer.lock"}),
    "maven": frozenset({"pom.xml"}),
}


class DatabaseMetadata(StrictModel):
    provisioned_at: str = Field(min_length=1, max_length=64)
    fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    size_bytes: int = Field(ge=1, le=MAX_DATABASE_BYTES)


class ManagedScanner(StrictModel):
    name: EngineName
    executable: str | None = Field(default=None, max_length=4096)
    version: str = Field(min_length=1, max_length=256)
    binary_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    container_image: str | None = Field(default=None, max_length=512)
    database: DatabaseMetadata | None = None

    @field_validator("executable")
    @classmethod
    def absolute_executable(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if "\x00" in value or not Path(value).is_absolute():
            raise ValueError("managed_executable_must_be_absolute")
        return value

    @model_validator(mode="after")
    def exactly_one_execution_identity(self) -> ManagedScanner:
        if (self.executable is None) == (self.container_image is None):
            raise ValueError("managed_execution_identity_required")
        if self.executable is not None and self.binary_hash is None:
            raise ValueError("managed_binary_hash_required")
        if self.container_image is not None:
            if self.binary_hash is not None or "@sha256:" not in self.container_image:
                raise ValueError("managed_container_digest_required")
            digest_part = self.container_image.rsplit("@sha256:", 1)[-1]
            if len(digest_part) != 64 or any(c not in "0123456789abcdef" for c in digest_part):
                raise ValueError("managed_container_digest_invalid")
        return self


class ManagedScannerManifest(StrictModel):
    schema_version: int = Field(default=1, ge=1, le=1)
    engines: list[ManagedScanner] = Field(default_factory=list, max_length=3)

    @model_validator(mode="after")
    def unique_engine_names(self) -> ManagedScannerManifest:
        names = [engine.name for engine in self.engines]
        if len(names) != len(set(names)):
            raise ValueError("duplicate_managed_engine")
        return self


def _private_dir(root: Path, *, create: bool) -> int | None:
    parent = root_fd(root)
    try:
        private_name = private_directory_name(parent)
        if create:
            try:
                os.mkdir(private_name, 0o700, dir_fd=parent)
            except FileExistsError:
                pass
        try:
            private = os.open(
                private_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent
            )
        except FileNotFoundError:
            return None
        info = os.fstat(private)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            os.close(private)
            raise WorkspaceError("private_directory_permissions")
        return private
    finally:
        os.close(parent)


def load_scanner_manifest(root: Path) -> ManagedScannerManifest | None:
    private = _private_dir(root, create=False)
    if private is None:
        return None
    try:
        try:
            info = os.stat(SCANNER_MANIFEST_FILE, dir_fd=private, follow_symlinks=False)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_nlink != 1
                or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600
            ):
                raise WorkspaceError("unsafe_scanner_manifest")
            raw = read_regular(
                private,
                SCANNER_MANIFEST_FILE,
                MAX_MANIFEST_BYTES,
                expected_identity=(info.st_dev, info.st_ino),
            )
        except FileNotFoundError:
            return None
        try:
            value = json.loads(raw)
            return ManagedScannerManifest.model_validate(value)
        except (json.JSONDecodeError, TypeError, ValidationError, ValueError):
            raise WorkspaceError("invalid_scanner_manifest") from None
    finally:
        os.close(private)


def save_scanner_manifest(root: Path, manifest: ManagedScannerManifest) -> None:
    encoded = json.dumps(
        manifest.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
    ).encode()
    if len(encoded) > MAX_MANIFEST_BYTES:
        raise WorkspaceError("scanner_manifest_too_large")
    private = _private_dir(root, create=True)
    if private is None:
        raise WorkspaceError("private_directory_missing")
    try:
        try:
            existing = os.stat(SCANNER_MANIFEST_FILE, dir_fd=private, follow_symlinks=False)
            if (
                not stat.S_ISREG(existing.st_mode)
                or existing.st_nlink != 1
                or existing.st_uid != os.getuid()
                or stat.S_IMODE(existing.st_mode) != 0o600
            ):
                raise WorkspaceError("unsafe_scanner_manifest")
        except FileNotFoundError:
            pass
        try:
            descriptor = os.open(
                SCANNER_MANIFEST_FILE,
                os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW,
                0o600,
                dir_fd=private,
            )
        except OSError:
            raise WorkspaceError("scanner_manifest_write_failed") from None
        try:
            view = memoryview(encoded)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError("scanner_manifest_write_failed")
                view = view[written:]
            os.fsync(descriptor)
            os.fchmod(descriptor, 0o600)
        finally:
            os.close(descriptor)
    finally:
        os.close(private)


def scanner_manifest_digest(root: Path) -> str:
    manifest = load_scanner_manifest(root)
    return digest(manifest.model_dump(mode="json") if manifest else {"status": "unconfigured"})


def _binary_name(engine: EngineName) -> str:
    return {"semgrep": "semgrep", "osv": "osv-scanner", "trivy": "trivy"}[engine]


def _entry_map(manifest: ManagedScannerManifest | None) -> dict[EngineName, ManagedScanner]:
    return {entry.name: entry for entry in manifest.engines} if manifest else {}


def _ensure_private_directory(root: Path) -> None:
    descriptor = _private_dir(root, create=True)
    if descriptor is None:
        raise WorkspaceError("private_directory_missing")
    os.close(descriptor)


def _verify_binary(entry: ManagedScanner) -> tuple[str, str, dict[str, str]]:
    isolation = scanner_isolation_mode()
    if entry.container_image is not None:
        return _verify_container(entry)
    if isolation == "unavailable":
        return "unavailable", "scanner_isolation_unavailable", {"isolation": isolation}
    if isolation != "seatbelt_default_deny":
        return "unavailable", "container_worker_required", {"isolation": isolation}
    if entry.executable is None or entry.binary_hash is None:
        return "unavailable", "managed_binary_identity_missing", {"isolation": isolation}
    executable = Path(entry.executable)
    if not executable.is_file():
        return "unavailable", "managed_binary_missing", {"isolation": isolation}
    try:
        actual_hash = _binary_hash(executable)
        actual_version = version_probe(executable)
    except OSError:
        return "unavailable", "managed_binary_unreadable", {"isolation": isolation}
    if actual_hash != entry.binary_hash:
        return "unavailable", "managed_binary_hash_mismatch", {"isolation": isolation}
    if actual_version != entry.version:
        return "unavailable", "managed_binary_version_mismatch", {"isolation": isolation}
    return (
        "ready",
        "managed_binary_verified",
        {
            "version": actual_version,
            "binary_hash": actual_hash,
            "isolation": isolation,
        },
    )


def _verify_container(entry: ManagedScanner) -> tuple[str, str, dict[str, str]]:
    isolation = container_runtime_mode()
    if isolation == "unavailable":
        return "unavailable", "container_runtime_unavailable", {"isolation": isolation}
    if not container_user_available():
        return "unavailable", "container_non_root_user_unavailable", {"isolation": isolation}
    expected_image = SCANNER_CONTAINER_IMAGES[entry.name]
    if entry.container_image != expected_image:
        return "unavailable", "container_image_not_allowed", {"isolation": isolation}
    if not container_image_present(entry.container_image):
        return (
            "unavailable",
            "container_image_missing",
            {"isolation": isolation, "image_digest": entry.container_image},
        )
    actual_version = container_version_probe(entry.name, entry.container_image)
    if actual_version != entry.version:
        return (
            "unavailable",
            "container_version_mismatch",
            {"isolation": isolation, "image_digest": entry.container_image},
        )
    return (
        "ready",
        "container_image_verified",
        {
            "version": actual_version,
            "image_digest": entry.container_image,
            "isolation": isolation,
        },
    )


def _database_home(root: Path, *, create: bool) -> Path | None:
    parent = root_fd(root)
    try:
        private_name = private_directory_name(parent)
    finally:
        os.close(parent)
    private = _private_dir(root, create=create)
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


def _database_fingerprint(home: Path) -> tuple[str, int] | None:
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


def _database_status(root: Path, entry: ManagedScanner) -> tuple[str, str, dict[str, str]]:
    if entry.database is None:
        return "unavailable", "osv_database_not_provisioned", {}
    home = _database_home(root, create=False)
    actual = _database_fingerprint(home) if home else None
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


def scanner_capabilities(root: Path | None = None) -> dict[str, dict[str, str]]:
    result = probe_optional_engines()
    if root is None:
        return result
    try:
        manifest = load_scanner_manifest(root)
    except WorkspaceError:
        return {
            name: {
                "status": "unavailable",
                "reason": "invalid_managed_config",
                "isolation": scanner_isolation_mode(),
            }
            for name in SCANNER_NAMES
        }
    entries = _entry_map(manifest)
    for name in SCANNER_NAMES:
        entry = entries.get(name)
        if entry is None:
            result[name] = {
                "status": "unavailable",
                "reason": "managed_engine_not_configured",
                "isolation": scanner_isolation_mode(),
            }
            continue
        status, reason, details = _verify_binary(entry)
        if status == "ready" and name == "osv":
            status, reason, database_details = _database_status(root, entry)
            details.update(database_details)
        result[name] = {"status": status, "reason": reason, **details}
    return result


def provision_scanners(
    root: Path,
    selected: Sequence[EngineName] | None = None,
    *,
    container: bool = False,
    pull: bool = False,
) -> dict[str, Any]:
    """Record identities, optionally pulling missing pinned images explicitly."""

    load_config(root)
    if pull and not container:
        raise ValueError("container_pull_requires_container")
    names = tuple(selected or SCANNER_NAMES)
    if any(name not in SCANNER_NAMES for name in names):
        raise ValueError("unsupported_scanner")
    _ensure_private_directory(root)
    with runtime_lock(root, "worker.lock", blocking=True):
        current = load_scanner_manifest(root)
        previous = _entry_map(current)
        entries = {name: entry for name, entry in previous.items() if name not in names}
        statuses: dict[str, dict[str, str]] = {}
        isolation = container_runtime_mode() if container else scanner_isolation_mode()
        for name in names:
            if container:
                image = SCANNER_CONTAINER_IMAGES[name]
                if isolation == "unavailable":
                    statuses[name] = {
                        "status": "unavailable",
                        "reason": "container_runtime_unavailable",
                        "isolation": isolation,
                    }
                    continue
                if not container_user_available():
                    statuses[name] = {
                        "status": "unavailable",
                        "reason": "container_non_root_user_unavailable",
                        "image_digest": image,
                        "isolation": isolation,
                    }
                    continue
                image_reason = "container_image_pinned"
                image_present = container_image_present(image)
                if not image_present and pull:
                    pulled, pull_reason = pull_container_image(image)
                    if not pulled:
                        statuses[name] = {
                            "status": "unavailable",
                            "reason": pull_reason,
                            "image_digest": image,
                            "isolation": isolation,
                        }
                        continue
                    image_present = container_image_present(image)
                    image_reason = "container_image_pulled"
                if not image_present:
                    statuses[name] = {
                        "status": "unavailable",
                        "reason": "container_image_missing",
                        "image_digest": image,
                        "isolation": isolation,
                    }
                    continue
                version = container_version_probe(name, image)
                if version is None:
                    statuses[name] = {
                        "status": "unavailable",
                        "reason": "container_version_probe_failed",
                        "image_digest": image,
                        "isolation": isolation,
                    }
                    continue
                old = previous.get(name)
                database = (
                    old.database
                    if name == "osv"
                    and old is not None
                    and old.container_image == image
                    and old.version == version
                    else None
                )
                entries[name] = ManagedScanner(
                    name=name,
                    version=version,
                    container_image=image,
                    database=database,
                )
                status = "ready" if name != "osv" or database else "unavailable"
                statuses[name] = {
                    "status": status,
                    "reason": image_reason if status == "ready" else "osv_database_not_provisioned",
                    "version": version,
                    "image_digest": image,
                    "isolation": isolation,
                }
                continue
            if isolation != "seatbelt_default_deny":
                statuses[name] = {
                    "status": "unavailable",
                    "reason": "container_worker_required",
                    "isolation": isolation,
                }
                continue
            resolved = shutil.which(_binary_name(name))
            if not resolved:
                statuses[name] = {
                    "status": "unavailable",
                    "reason": "binary_missing",
                    "isolation": isolation,
                }
                continue
            executable = Path(resolved).resolve()
            version = version_probe(executable)
            try:
                binary_hash = _binary_hash(executable)
            except OSError:
                binary_hash = None
            if version is None or binary_hash is None:
                statuses[name] = {
                    "status": "unavailable",
                    "reason": "binary_unreadable",
                    "isolation": isolation,
                }
                continue
            old = previous.get(name)
            database = (
                old.database
                if name == "osv"
                and old is not None
                and old.executable == str(executable)
                and old.version == version
                and old.binary_hash == binary_hash
                else None
            )
            entries[name] = ManagedScanner(
                name=name,
                executable=str(executable),
                version=version,
                binary_hash=binary_hash,
                database=database,
            )
            status = (
                "ready"
                if isolation != "unavailable" and (name != "osv" or database)
                else "unavailable"
            )
            status_reason = (
                "scanner_isolation_unavailable"
                if isolation == "unavailable"
                else "binary_pinned"
                if name != "osv" or database
                else "osv_database_not_provisioned"
            )
            statuses[name] = {
                "status": status,
                "reason": status_reason,
                "version": version,
                "binary_hash": binary_hash,
                "isolation": isolation,
            }
        manifest = ManagedScannerManifest(
            engines=[entries[name] for name in SCANNER_NAMES if name in entries]
        )
        save_scanner_manifest(root, manifest)
    return {
        "manifest_digest": digest(manifest.model_dump(mode="json")),
        "engines": statuses,
    }


def provision_osv_database(root: Path) -> dict[str, Any]:
    """Download OSV data only through an explicit, bounded setup operation."""

    config = load_config(root)
    _ensure_private_directory(root)
    with runtime_lock(root, "worker.lock", blocking=True):
        manifest = load_scanner_manifest(root)
        entry = _entry_map(manifest).get("osv")
        if entry is None:
            return {"status": "unavailable", "reason": "osv_binary_not_configured"}
        status, reason, _ = _verify_binary(entry)
        if status != "ready":
            return {"status": status, "reason": reason}
        scanner_inputs, _ = capture(root, config, include_scanner_inputs=True)
        input_names = {Path(path).name for path in scanner_inputs}
        ecosystems = {"python"} | {
            ecosystem
            for ecosystem, names in _OSV_PROVISION_INPUTS.items()
            if input_names.intersection(names)
        }
        home = _database_home(root, create=True)
        if home is None:
            return {"status": "unavailable", "reason": "osv_runtime_unavailable"}
        with tempfile.TemporaryDirectory(prefix="plenger-osv-provision-") as target:
            requirements = Path(target) / "requirements.txt"
            requirements.write_text("requests==2.31.0\n", encoding="utf-8")
            if "npm" in ecosystems:
                package_lock = Path(target) / "package-lock.json"
                package_lock.write_text(
                    json.dumps(
                        {
                            "name": "plenger-osv-provision-fixture",
                            "version": "1.0.0",
                            "lockfileVersion": 3,
                            "requires": True,
                            "packages": {
                                "": {
                                    "name": "plenger-osv-provision-fixture",
                                    "version": "1.0.0",
                                    "dependencies": {"lodash": "4.17.21"},
                                },
                                "node_modules/lodash": {
                                    "version": "4.17.21",
                                    "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
                                },
                            },
                        },
                        sort_keys=True,
                    ),
                    encoding="utf-8",
                )
            if "cargo" in ecosystems:
                (Path(target) / "Cargo.lock").write_text(
                    "version = 3\n\n"
                    '[[package]]\nname = "plenger-osv-provision-fixture"\nversion = "1.0.0"\n\n'
                    '[[package]]\nname = "serde"\nversion = "1.0.0"\n'
                    'source = "registry+https://github.com/rust-lang/crates.io-index"\n',
                    encoding="utf-8",
                )
            if "go" in ecosystems:
                (Path(target) / "go.mod").write_text(
                    "module example.com/plenger-osv-provision-fixture\n\n"
                    "go 1.22\n\nrequire github.com/pkg/errors v0.9.1\n",
                    encoding="utf-8",
                )
            if "ruby" in ecosystems:
                (Path(target) / "Gemfile.lock").write_text(
                    "GEM\n  remote: https://rubygems.org/\n  specs:\n"
                    "    rack (3.0.0)\n\nPLATFORMS\n  ruby\n\n"
                    "DEPENDENCIES\n  rack (= 3.0.0)\n",
                    encoding="utf-8",
                )
            if "composer" in ecosystems:
                (Path(target) / "composer.lock").write_text(
                    json.dumps(
                        {
                            "packages": [{"name": "symfony/console", "version": "v6.4.0"}],
                            "packages-dev": [],
                        },
                        sort_keys=True,
                    ),
                    encoding="utf-8",
                )
            if "maven" in ecosystems:
                (Path(target) / "pom.xml").write_text(
                    '<project xmlns="http://maven.apache.org/POM/4.0.0">'
                    "<modelVersion>4.0.0</modelVersion>"
                    "<groupId>example.com</groupId>"
                    "<artifactId>plenger-osv-provision-fixture</artifactId>"
                    "<version>1.0.0</version>"
                    "<dependencies><dependency><groupId>commons-io</groupId>"
                    "<artifactId>commons-io</artifactId><version>2.8.0</version>"
                    "</dependency></dependencies></project>",
                    encoding="utf-8",
                )
            try:
                if entry.container_image is not None:
                    plan = plan_scanner(
                        "osv",
                        Path(target),
                        expected_version=entry.version,
                        container_image=entry.container_image,
                        runtime_home=home,
                        provisioning=True,
                        timeout_seconds=300,
                    )
                else:
                    if entry.binary_hash is None or entry.executable is None:
                        return {
                            "status": "unavailable",
                            "reason": "managed_binary_identity_missing",
                        }
                    plan = plan_scanner(
                        "osv",
                        Path(target),
                        expected_version=entry.version,
                        expected_binary_hash=entry.binary_hash,
                        executable=Path(entry.executable),
                        runtime_home=home,
                        provisioning=True,
                        timeout_seconds=300,
                    )
                raw = _bounded_process(plan)
                if plan.container_image is not None:
                    raw = _map_container_output(raw, "osv")
                # Validate that the command returned the schema we will later consume.
                from plenger.adapters.scanners import normalize_osv

                normalize_osv(raw, base_dir=Path(target))
            except ScannerExecutionError as error:
                return {
                    "status": "unavailable",
                    "reason": f"osv_database_{error.reason_code}",
                }
            except (ScannerOutputError, ValueError):
                return {"status": "unavailable", "reason": "osv_database_download_failed"}
        database_state = _database_fingerprint(home)
        if database_state is None:
            return {"status": "unavailable", "reason": "osv_database_not_created"}
        fingerprint, size_bytes = database_state
        updated = entry.model_copy(
            update={
                "database": DatabaseMetadata(
                    provisioned_at=now(), fingerprint=fingerprint, size_bytes=size_bytes
                )
            }
        )
        entries = _entry_map(manifest)
        entries["osv"] = updated
        updated_manifest = ManagedScannerManifest(
            engines=[entries[name] for name in SCANNER_NAMES if name in entries]
        )
        save_scanner_manifest(root, updated_manifest)
        return {
            "status": "ready",
            "reason": "osv_database_provisioned",
            "database_bytes": str(size_bytes),
            "ecosystems": sorted(ecosystems),
            "manifest_digest": digest(updated_manifest.model_dump(mode="json")),
        }


def _safe_stage_path(root: Path, relative: str) -> Path:
    candidate = Path(relative)
    if (
        not relative
        or candidate.is_absolute()
        or "\\" in relative
        or any(part in {"", ".", ".."} for part in candidate.parts)
    ):
        raise WorkspaceError("invalid_scanner_stage_path")
    resolved = (root / candidate).resolve()
    if not resolved.is_relative_to(root.resolve()):
        raise WorkspaceError("scanner_stage_path_outside_target")
    return resolved


@contextmanager
def _stage_files(files: dict[str, str]) -> Iterator[Path]:
    with tempfile.TemporaryDirectory(prefix="plenger-scanner-stage-") as temporary:
        root = Path(temporary)
        for relative, source in files.items():
            target = _safe_stage_path(root, relative)
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            descriptor = os.open(
                target,
                os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
            )
            try:
                encoded = source.encode("utf-8")
                view = memoryview(encoded)
                while view:
                    written = os.write(descriptor, view)
                    if written <= 0:
                        raise WorkspaceError("scanner_stage_write_failed")
                    view = view[written:]
                os.fsync(descriptor)
                os.lseek(descriptor, 0, os.SEEK_SET)
                verified = bytearray()
                while len(verified) <= len(encoded):
                    chunk = os.read(descriptor, min(65536, len(encoded) + 1 - len(verified)))
                    if not chunk:
                        break
                    verified.extend(chunk)
                info = os.fstat(descriptor)
                if (
                    bytes(verified) != encoded
                    or not stat.S_ISREG(info.st_mode)
                    or info.st_nlink != 1
                    or info.st_uid != os.getuid()
                    or info.st_size != len(encoded)
                ):
                    raise WorkspaceError("scanner_stage_copy_changed")
            finally:
                os.close(descriptor)
        yield root


def run_managed_scanners(
    root: Path, files: dict[str, str]
) -> tuple[list[ScannerResult], dict[str, dict[str, str]]]:
    """Run configured engines against an owner-only capture staging directory."""

    states = scanner_capabilities(root)
    manifest = load_scanner_manifest(root)
    if manifest is None:
        return [], states
    entries = _entry_map(manifest)
    results: list[ScannerResult] = []
    with _stage_files(files) as staged:
        for name in SCANNER_NAMES:
            entry = entries.get(name)
            if entry is None or states[name].get("status") != "ready":
                continue
            runtime_home = _database_home(root, create=False) if name == "osv" else None
            try:
                if entry.container_image is not None:
                    plan = plan_scanner(
                        name,
                        staged,
                        expected_version=entry.version,
                        container_image=entry.container_image,
                        runtime_home=runtime_home,
                    )
                else:
                    if entry.binary_hash is None or entry.executable is None:
                        raise ScannerUnavailable("managed_binary_identity_missing")
                    plan = plan_scanner(
                        name,
                        staged,
                        expected_version=entry.version,
                        expected_binary_hash=entry.binary_hash,
                        executable=Path(entry.executable),
                        runtime_home=runtime_home,
                    )
                result = execute_scanner(plan)
                if name == "osv" and result.status == "completed":
                    unresolved = unresolved_dependency_findings(files)
                    if unresolved:
                        result = result.model_copy(
                            update={"findings": [*result.findings, *unresolved]}
                        )
            except (OSError, ScannerExecutionError, ScannerUnavailable, ValueError) as exc:
                states[name] = {
                    "status": "error",
                    "reason": str(exc)[:128],
                    "isolation": states[name].get("isolation", scanner_isolation_mode()),
                }
                continue
            results.append(result)
            states[name] = {
                "status": result.status,
                "reason": result.reason,
                "version": entry.version,
                "isolation": states[name].get("isolation", scanner_isolation_mode()),
            }
    return results, states


def scanner_findings_to_report(results: Sequence[ScannerResult]) -> list[dict[str, Any]]:
    """Convert normalized scanner evidence to the report finding contract."""

    from plenger.adapters.correlation import correlate_scanner_results

    findings: list[dict[str, Any]] = []
    for correlated in correlate_scanner_results(results):
        evidence_items: list[dict[str, Any]] = []
        for member in correlated.evidence:
            observed = str(redact(member.observed))[:2000]
            evidence_items.append(
                {
                    "id": digest(
                        [
                            "scanner-evidence",
                            member.engine,
                            member.rule_id,
                            member.path,
                            member.line,
                            observed,
                        ]
                    ),
                    "source": f"{member.engine}-scanner-v1",
                    "observed": observed,
                    "redaction_version": "scanner-normalized-v1",
                }
            )
        if not evidence_items:
            continue
        finding: dict[str, Any] = {
            "id": correlated.fingerprint,
            "fingerprint": correlated.fingerprint,
            "rule_id": ",".join(correlated.rule_ids)[:256],
            "kind": correlated.kind,
            "severity": correlated.severity,
            "severity_source": "scanner:" + ",".join(correlated.engines),
            "validation_state": "candidate",
            "lifecycle_state": "open",
            "assessment_state": "needs_review",
            "title": f"Kandidat {correlated.kind} dari {', '.join(correlated.engines)}",
            "source_ref": {"path": correlated.path, "line": correlated.line or 1},
            "evidence": evidence_items[0],
        }
        if len(evidence_items) > 1:
            finding["evidence_refs"] = evidence_items
        findings.append(finding)
    return findings


__all__ = [
    "ManagedScanner",
    "ManagedScannerManifest",
    "load_scanner_manifest",
    "provision_osv_database",
    "provision_scanners",
    "run_managed_scanners",
    "save_scanner_manifest",
    "scanner_capabilities",
    "scanner_findings_to_report",
    "scanner_manifest_digest",
]
