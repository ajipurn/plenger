"""The owner-only managed scanner manifest and the private directory holding it."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

from pydantic import Field, ValidationError, field_validator, model_validator

from plenger.adapters.scanners.models import EngineName
from plenger.domain.base import StrictModel
from plenger.services.workspace import (
    WorkspaceError,
    private_directory_name,
    read_regular,
    root_fd,
)
from plenger.storage.runs import digest

SCANNER_NAMES: tuple[EngineName, ...] = ("semgrep", "osv", "trivy")
SCANNER_MANIFEST_FILE = "scanner-manifest.json"
MAX_MANIFEST_BYTES = 64 * 1024
MAX_DATABASE_BYTES = 512 * 1024 * 1024


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


def open_private_dir(root: Path, *, create: bool) -> int | None:
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
    private = open_private_dir(root, create=False)
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
    private = open_private_dir(root, create=True)
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


def entry_map(manifest: ManagedScannerManifest | None) -> dict[EngineName, ManagedScanner]:
    return {entry.name: entry for entry in manifest.engines} if manifest else {}


def ensure_private_directory(root: Path) -> None:
    descriptor = open_private_dir(root, create=True)
    if descriptor is None:
        raise WorkspaceError("private_directory_missing")
    os.close(descriptor)
