"""Explicit setup commands that record scanner identities and the OSV database."""

from __future__ import annotations

import json
import shutil
import tempfile
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from plenger.adapters.scanners.binaries import hash_binary, version_probe
from plenger.adapters.scanners.containers import (
    SCANNER_CONTAINER_IMAGES,
    container_image_present,
    container_runtime_mode,
    container_user_available,
    container_version_probe,
    pull_container_image,
)
from plenger.adapters.scanners.execution import run_scanner_process, scanner_isolation_mode
from plenger.adapters.scanners.models import EngineName, ScannerExecutionError, ScannerOutputError
from plenger.adapters.scanners.normalize import map_container_output, normalize_osv
from plenger.adapters.scanners.planning import plan_scanner
from plenger.services.scanners.database import database_fingerprint, database_home
from plenger.services.scanners.manifest import (
    SCANNER_NAMES,
    DatabaseMetadata,
    ManagedScanner,
    ManagedScannerManifest,
    ensure_private_directory,
    entry_map,
    load_scanner_manifest,
    save_scanner_manifest,
)
from plenger.services.scanners.verification import verify_engine
from plenger.services.workspace import capture, load_config
from plenger.storage.locking import runtime_lock
from plenger.storage.runs import digest, now

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


def _binary_name(engine: EngineName) -> str:
    return {"semgrep": "semgrep", "osv": "osv-scanner", "trivy": "trivy"}[engine]


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
    ensure_private_directory(root)
    with runtime_lock(root, "worker.lock", blocking=True):
        current = load_scanner_manifest(root)
        previous = entry_map(current)
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
                binary_hash = hash_binary(executable)
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
    ensure_private_directory(root)
    with runtime_lock(root, "worker.lock", blocking=True):
        manifest = load_scanner_manifest(root)
        entry = entry_map(manifest).get("osv")
        if entry is None:
            return {"status": "unavailable", "reason": "osv_binary_not_configured"}
        status, reason, _ = verify_engine(entry)
        if status != "ready":
            return {"status": status, "reason": reason}
        scanner_inputs, _ = capture(root, config, include_scanner_inputs=True)
        input_names = {Path(path).name for path in scanner_inputs}
        ecosystems = {"python"} | {
            ecosystem
            for ecosystem, names in _OSV_PROVISION_INPUTS.items()
            if input_names.intersection(names)
        }
        home = database_home(root, create=True)
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
                raw = run_scanner_process(plan)
                if plan.container_image is not None:
                    raw = map_container_output(raw, "osv")
                # Validate that the command returned the schema we will later consume.
                normalize_osv(raw, base_dir=Path(target))
            except ScannerExecutionError as error:
                return {
                    "status": "unavailable",
                    "reason": f"osv_database_{error.reason_code}",
                }
            except (ScannerOutputError, ValueError):
                return {"status": "unavailable", "reason": "osv_database_download_failed"}
        database_state = database_fingerprint(home)
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
        entries = entry_map(manifest)
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
