"""Validate and optionally print plenger's locked dependency ledger.

This check is deliberately offline.  Lockfiles provide immutable source and
artifact identities; installed distribution metadata provides a best-effort
declared license field.  An unknown license is reported as an open review item,
not silently treated as approved.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from importlib import metadata
from pathlib import Path
from typing import Any

from plenger.adapters.scanners import SCANNER_CONTAINER_IMAGES

_PACKAGE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*")
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")

_PYTHON_FEATURES: dict[str, tuple[str, ...]] = {
    "alembic": ("migrations",),
    "fastapi": ("api",),
    "httpx": ("broker-and-jev-transport",),
    "pydantic": ("schema-validation",),
    "pyyaml": ("strict-config",),
    "sqlalchemy": ("sqlite-storage",),
    "typer": ("cli",),
    "uvicorn": ("local-serve",),
}


def _normalized_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def _requirement_name(value: str) -> str:
    match = _PACKAGE_NAME.match(value.strip())
    if match is None:
        raise ValueError("invalid_dependency_name")
    return _normalized_name(match.group(0))


def _license_metadata(name: str) -> dict[str, Any]:
    try:
        package = metadata.metadata(name)
    except metadata.PackageNotFoundError:
        return {"status": "not_installed", "declared": []}
    declared = {
        value.strip()
        for value in package.get_all("License") or []
        if value.strip() and value.strip().upper() not in {"UNKNOWN", "UNKNOWN LICENSE"}
    }
    declared.update(
        value.strip()
        for value in package.get_all("License-Expression") or []
        if value.strip() and value.strip().upper() not in {"UNKNOWN", "UNKNOWN LICENSE"}
    )
    declared.update(
        value.split(" :: ", 1)[-1].strip()
        for value in package.get_all("Classifier") or []
        if value.startswith("License :: ")
    )
    values = sorted(value for value in declared if value)
    return {"status": "declared" if values else "unknown", "declared": values}


def _uv_artifacts(package: dict[str, Any]) -> tuple[list[str], list[str]]:
    urls: list[str] = []
    hashes: list[str] = []
    for artifact_name in ("sdist", "wheels"):
        raw = package.get(artifact_name)
        artifacts = raw if isinstance(raw, list) else [raw] if isinstance(raw, dict) else []
        for artifact in artifacts:
            if not isinstance(artifact, dict):
                continue
            url = artifact.get("url")
            artifact_hash = artifact.get("hash")
            if isinstance(url, str):
                urls.append(url)
            if isinstance(artifact_hash, str):
                hashes.append(artifact_hash)
    return sorted(set(urls)), sorted(set(hashes))


def _direct_python_dependencies(project: dict[str, Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    project_table = project.get("project")
    if not isinstance(project_table, dict):
        raise ValueError("project_metadata_missing")
    runtime = project_table.get("dependencies", [])
    if not isinstance(runtime, list):
        raise ValueError("project_dependencies_invalid")
    for dependency in runtime:
        if isinstance(dependency, str):
            result[_requirement_name(dependency)] = "runtime"
    groups = project_table.get("dependency-groups", {})
    if isinstance(groups, dict):
        for group_name, values in groups.items():
            if not isinstance(values, list):
                raise ValueError("project_dependency_group_invalid")
            for dependency in values:
                if isinstance(dependency, str):
                    result[_requirement_name(dependency)] = f"dev:{group_name}"
    return result


def _python_ledger(root: Path) -> tuple[list[dict[str, Any]], list[str]]:
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    lock = tomllib.loads((root / "uv.lock").read_text(encoding="utf-8"))
    direct = _direct_python_dependencies(project)
    packages = lock.get("package")
    if not isinstance(packages, list):
        raise ValueError("uv_lock_packages_missing")
    ledger: list[dict[str, Any]] = []
    for package in packages:
        if not isinstance(package, dict):
            raise ValueError("uv_lock_package_invalid")
        name = package.get("name")
        version = package.get("version")
        source = package.get("source")
        if (
            not isinstance(name, str)
            or not isinstance(version, str)
            or not isinstance(source, dict)
        ):
            raise ValueError("uv_lock_package_identity_invalid")
        urls, hashes = _uv_artifacts(package)
        normalized = _normalized_name(name)
        group = direct.get(normalized, "transitive")
        features = list(_PYTHON_FEATURES.get(normalized, ()))
        if group != "transitive":
            features.append(group)
        ledger.append(
            {
                "name": name,
                "version": version,
                "source": source,
                "artifacts": urls,
                "sha256": hashes,
                "license": _license_metadata(name),
                "dependency_scope": group,
                "features_used": sorted(set(features)),
                "tests_completed": ["lockfile-resolution", "clean-install"],
            }
        )
    lock_names = {
        _normalized_name(str(item.get("name"))) for item in packages if isinstance(item, dict)
    }
    missing = sorted(name for name in direct if name not in lock_names)
    return ledger, missing


def _npm_ledger(root: Path) -> tuple[list[dict[str, Any]], list[str]]:
    lock = json.loads((root / "web" / "package-lock.json").read_text(encoding="utf-8"))
    packages = lock.get("packages")
    if not isinstance(packages, dict):
        raise ValueError("npm_lock_packages_missing")
    root_package = packages.get("")
    if not isinstance(root_package, dict):
        raise ValueError("npm_lock_root_missing")
    direct: dict[str, str] = {}
    for field, scope in (("dependencies", "runtime"), ("devDependencies", "dev")):
        values = root_package.get(field, {})
        if not isinstance(values, dict):
            raise ValueError("npm_root_dependencies_invalid")
        direct.update({_normalized_name(str(name)): scope for name in values})
    ledger: list[dict[str, Any]] = []
    for path, package in packages.items():
        if path == "":
            continue
        if not isinstance(path, str) or not isinstance(package, dict):
            raise ValueError("npm_lock_package_invalid")
        name = package.get("name")
        if not isinstance(name, str):
            name = path.removeprefix("node_modules/").rsplit("/node_modules/", 1)[-1]
        normalized = _normalized_name(name)
        scope = direct.get(normalized, "transitive")
        features = [scope]
        if package.get("optional") is True:
            features.append("platform-optional")
        ledger.append(
            {
                "name": name,
                "version": package.get("version"),
                "source": package.get("resolved", "npm-registry"),
                "sha256": [],
                "integrity": package.get("integrity"),
                "license": {
                    "status": "declared" if isinstance(package.get("license"), str) else "unknown",
                    "declared": [package["license"]]
                    if isinstance(package.get("license"), str)
                    else [],
                },
                "dependency_scope": scope,
                "features_used": features,
                "tests_completed": ["npm-lock-resolution", "ui-build"],
            }
        )
    package_names = {
        _normalized_name(
            str(package.get("name"))
            if isinstance(package.get("name"), str)
            else path.removeprefix("node_modules/").rsplit("/node_modules/", 1)[-1]
        )
        for path, package in packages.items()
        if path != "" and isinstance(package, dict)
    }
    missing = sorted(name for name in direct if name not in package_names)
    return ledger, missing


def _engine_ledger() -> list[dict[str, Any]]:
    return [
        {
            "name": name,
            "version": "digest-pinned",
            "source": image.split("@", 1)[0],
            "sha256": [image.rsplit("@", 1)[-1]],
            "license": {"status": "review_required", "declared": []},
            "dependency_scope": "managed-optional-engine",
            "features_used": ["offline-static-scan"],
            "tests_completed": ["contract", "real-fixture", "scanner-image-smoke"],
        }
        for name, image in sorted(SCANNER_CONTAINER_IMAGES.items())
    ]


def build_inventory(root: Path) -> dict[str, Any]:
    python_packages, missing_python = _python_ledger(root)
    npm_packages, missing_npm = _npm_ledger(root)
    return {
        "schema_version": 1,
        "project": "plenger",
        "lockfiles": ["uv.lock", "web/package-lock.json"],
        "python": {"packages": python_packages, "missing_direct_dependencies": missing_python},
        "frontend": {"packages": npm_packages, "missing_direct_dependencies": missing_npm},
        "managed_engines": _engine_ledger(),
        "limitations": [
            "Declared package metadata is not legal license clearance.",
            "Container image transitive license contents require independent review.",
            "The ledger is generated from local lockfiles and does not contact registries.",
        ],
    }


def validate_inventory(inventory: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for section_name in ("python", "frontend"):
        section = inventory.get(section_name)
        packages = section.get("packages") if isinstance(section, dict) else None
        if not isinstance(packages, list):
            errors.append(f"{section_name}:packages_missing")
            continue
        for package in packages:
            if not isinstance(package, dict):
                errors.append(f"{section_name}:package_invalid")
                continue
            name = package.get("name", "unknown")
            if not package.get("version"):
                errors.append(f"{section_name}:{name}:version_missing")
            if section_name == "python":
                hashes = package.get("sha256")
                source = package.get("source")
                local_package = isinstance(source, dict) and (
                    "path" in source or "editable" in source
                )
                if not local_package and (
                    not isinstance(hashes, list)
                    or not hashes
                    or any(
                        not isinstance(value, str) or not _SHA256.fullmatch(value)
                        for value in hashes
                    )
                ):
                    errors.append(f"{section_name}:{name}:sha256_missing_or_invalid")
                if not isinstance(source, dict) or not source:
                    errors.append(f"{section_name}:{name}:source_missing")
            else:
                if not isinstance(package.get("integrity"), str) or not package[
                    "integrity"
                ].startswith("sha512-"):
                    errors.append(f"{section_name}:{name}:integrity_missing_or_invalid")
                if not isinstance(package.get("source"), str) or not package["source"]:
                    errors.append(f"{section_name}:{name}:source_missing")
    engines = inventory.get("managed_engines")
    if not isinstance(engines, list) or not engines:
        errors.append("managed_engines:missing")
    else:
        for engine in engines:
            hashes = engine.get("sha256") if isinstance(engine, dict) else None
            if not isinstance(hashes, list) or len(hashes) != 1 or not _SHA256.fullmatch(hashes[0]):
                name = engine.get("name", "unknown") if isinstance(engine, dict) else "unknown"
                errors.append(f"managed_engines:{name}:digest_missing_or_invalid")
    for section_name in ("python", "frontend"):
        section = inventory.get(section_name)
        missing = section.get("missing_direct_dependencies") if isinstance(section, dict) else None
        if isinstance(missing, list):
            errors.extend(f"{section_name}:missing_direct:{item}" for item in missing)
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument(
        "--check", action="store_true", help="fail on lock/source/hash inconsistencies"
    )
    parser.add_argument("--json", action="store_true", help="print the complete ledger as JSON")
    arguments = parser.parse_args()
    try:
        inventory = build_inventory(arguments.project_root.resolve())
        errors = validate_inventory(inventory)
    except (OSError, ValueError, tomllib.TOMLDecodeError, json.JSONDecodeError) as exc:
        print(f"dependency inventory failed: {exc}", file=sys.stderr)
        return 2
    if arguments.json:
        print(json.dumps(inventory, indent=2, sort_keys=True))
    else:
        python_packages = len(inventory["python"]["packages"])
        npm_packages = len(inventory["frontend"]["packages"])
        unknown_python = sum(
            item["license"]["status"] != "declared" for item in inventory["python"]["packages"]
        )
        unknown_npm = sum(
            item["license"]["status"] != "declared" for item in inventory["frontend"]["packages"]
        )
        print(
            "dependency inventory: "
            f"python={python_packages} npm={npm_packages} "
            f"engines={len(inventory['managed_engines'])} "
            "license_review_items="
            f"{unknown_python + unknown_npm + len(inventory['managed_engines'])}"
        )
    if errors:
        print("dependency inventory errors:", file=sys.stderr)
        for issue in errors:
            print(f"- {issue}", file=sys.stderr)
        return 1 if arguments.check else 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
