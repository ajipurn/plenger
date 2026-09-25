"""Revalidation of managed scanner identities before they are reported ready."""

from __future__ import annotations

from pathlib import Path

from plenger.adapters.scanners.binaries import hash_binary, version_probe
from plenger.adapters.scanners.containers import (
    SCANNER_CONTAINER_IMAGES,
    container_image_present,
    container_runtime_mode,
    container_user_available,
    container_version_probe,
)
from plenger.adapters.scanners.execution import probe_optional_engines, scanner_isolation_mode
from plenger.services.scanners.database import database_status
from plenger.services.scanners.manifest import (
    SCANNER_NAMES,
    ManagedScanner,
    entry_map,
    load_scanner_manifest,
)
from plenger.services.workspace import WorkspaceError


def verify_engine(entry: ManagedScanner) -> tuple[str, str, dict[str, str]]:
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
        actual_hash = hash_binary(executable)
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
    entries = entry_map(manifest)
    for name in SCANNER_NAMES:
        entry = entries.get(name)
        if entry is None:
            result[name] = {
                "status": "unavailable",
                "reason": "managed_engine_not_configured",
                "isolation": scanner_isolation_mode(),
            }
            continue
        status, reason, details = verify_engine(entry)
        if status == "ready" and name == "osv":
            status, reason, database_details = database_status(root, entry)
            details.update(database_details)
        result[name] = {"status": status, "reason": reason, **details}
    return result
