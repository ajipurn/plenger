"""Run the explicit OSV provisioning and offline dependency-control smoke."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

from plenger.services.scanners.baseline import run_managed_scanners
from plenger.services.scanners.provisioning import provision_osv_database, provision_scanners
from plenger.services.workspace import initialize


class OsvCheckError(RuntimeError):
    """Raised when the pinned OSV smoke cannot be completed."""


def _findings(results: list[Any]) -> list[Any]:
    return [finding for result in results for finding in result.findings]


def _uv_lock(version: str) -> str:
    return (
        "version = 1\n"
        "revision = 1\n"
        'requires-python = ">=3.12"\n\n'
        "[[package]]\n"
        'name = "requests"\n'
        f'version = "{version}"\n'
        'source = { registry = "https://pypi.org/simple" }\n'
    )


def _package_lock(version: str, *, package: str = "lodash") -> str:
    return json.dumps(
        {
            "name": "plenger-osv-npm-fixture",
            "version": "1.0.0",
            "lockfileVersion": 3,
            "requires": True,
            "packages": {
                "": {
                    "name": "plenger-osv-npm-fixture",
                    "version": "1.0.0",
                    "dependencies": {package: version},
                },
                f"node_modules/{package}": {
                    "version": version,
                    "resolved": f"https://registry.npmjs.org/{package}/-/{package}-{version}.tgz",
                },
            },
        },
        sort_keys=True,
    )


def _cargo_lock(version: str) -> str:
    return (
        "version = 3\n\n"
        "[[package]]\n"
        'name = "time"\n'
        f'version = "{version}"\n'
        'source = "registry+https://github.com/rust-lang/crates.io-index"\n'
    )


def _go_mod(version: str) -> str:
    return (
        "module example.com/plenger-osv-fixture\n\n"
        "go 1.22\n\n"
        f"require github.com/golang-jwt/jwt/v4 {version}\n"
    )


def _gemfile_lock(version: str) -> str:
    return (
        "GEM\n  remote: https://rubygems.org/\n  specs:\n"
        f"    rack ({version})\n\n"
        "PLATFORMS\n  ruby\n\n"
        f"DEPENDENCIES\n  rack (= {version})\n"
    )


def _composer_lock(package: str, version: str) -> str:
    return json.dumps(
        {"packages": [{"name": package, "version": version}], "packages-dev": []},
        sort_keys=True,
    )


def _maven_pom(group: str, artifact: str, version: str) -> str:
    return (
        '<project xmlns="http://maven.apache.org/POM/4.0.0">'
        "<modelVersion>4.0.0</modelVersion>"
        "<groupId>example.com</groupId><artifactId>plenger-osv-fixture</artifactId>"
        "<version>1.0.0</version><dependencies><dependency>"
        f"<groupId>{group}</groupId><artifactId>{artifact}</artifactId>"
        f"<version>{version}</version></dependency></dependencies></project>"
    )


def run_check() -> dict[str, Any]:
    """Provision a throwaway local database, then run all dependency controls."""

    with tempfile.TemporaryDirectory(prefix="plenger-osv-check-") as temporary:
        root = Path(temporary)
        initialize(root)
        (root / "package-lock.json").write_text(
            _package_lock("19.3.0", package="react"), encoding="utf-8"
        )
        for input_name in ("Cargo.lock", "go.mod", "Gemfile.lock", "composer.lock", "pom.xml"):
            (root / input_name).write_text("{}", encoding="utf-8")
        provisioning = provision_scanners(root, ["osv"], container=True)
        status = provisioning["engines"].get("osv", {})
        if status.get("status") != "unavailable":
            raise OsvCheckError("unexpected_initial_osv_status")
        database = provision_osv_database(root)
        if database.get("status") != "ready":
            raise OsvCheckError(str(database.get("reason", "osv_database_unavailable")))
        expected_ecosystems = {
            "cargo",
            "composer",
            "go",
            "maven",
            "npm",
            "python",
            "ruby",
        }
        if set(database.get("ecosystems", [])) != expected_ecosystems:
            raise OsvCheckError("unexpected_provisioned_ecosystems")

        cases = {
            "vulnerable": {"requirements.txt": "requests==2.31.0\n"},
            "fixed": {"requirements.txt": "requests==2.33.0\n"},
            "unresolved": {"requirements.txt": "requests\n"},
            "ranged": {"requirements.txt": "requests>=2.0,<3.0\n"},
            "uv_lock_vulnerable": {"uv.lock": _uv_lock("2.31.0")},
            "uv_lock_fixed": {"uv.lock": _uv_lock("2.33.0")},
            "npm_lock_vulnerable": {"package-lock.json": _package_lock("4.17.20")},
            "npm_lock_fixed": {"package-lock.json": _package_lock("19.3.0", package="react")},
            "cargo_vulnerable": {"Cargo.lock": _cargo_lock("0.3.7")},
            "cargo_fixed": {"Cargo.lock": _cargo_lock("0.3.47")},
            "go_vulnerable": {"go.mod": _go_mod("v4.3.0")},
            "go_fixed": {"go.mod": _go_mod("v4.7.2")},
            "ruby_vulnerable": {"Gemfile.lock": _gemfile_lock("2.2.3")},
            "ruby_fixed": {"Gemfile.lock": _gemfile_lock("3.2.6")},
            "composer_vulnerable": {
                "composer.lock": _composer_lock("laminas/laminas-diactoros", "2.0.0")
            },
            "composer_fixed": {
                "composer.lock": _composer_lock("laminas/laminas-diactoros", "3.5.0")
            },
            "maven_vulnerable": {
                "pom.xml": _maven_pom("org.apache.commons", "commons-text", "1.9")
            },
            "maven_fixed": {"pom.xml": _maven_pom("org.apache.commons", "commons-text", "1.13.0")},
            "npm_manifest": {
                "package.json": json.dumps(
                    {
                        "dependencies": {
                            "range-demo": "^1.2.3",
                            "source-demo": "git+https://example.invalid/source.git",
                        }
                    }
                )
            },
        }
        outputs: dict[str, list[Any]] = {}
        states: dict[str, dict[str, str]] = {}
        for name, files in cases.items():
            results, case_states = run_managed_scanners(root, files)
            outputs[name] = _findings(results)
            states[name] = case_states["osv"]

        incomplete = [name for name, state in states.items() if state.get("status") != "completed"]
        if incomplete:
            details = {name: states[name] for name in incomplete}
            raise OsvCheckError(f"osv_case_incomplete:{json.dumps(details, sort_keys=True)}")
        if not outputs["vulnerable"]:
            raise OsvCheckError("vulnerable_control_not_detected")
        if outputs["fixed"]:
            raise OsvCheckError("fixed_control_detected")
        if not outputs["uv_lock_vulnerable"]:
            raise OsvCheckError("uv_lock_vulnerable_control_not_detected")
        if outputs["uv_lock_fixed"]:
            raise OsvCheckError("uv_lock_fixed_control_detected")
        if not outputs["npm_lock_vulnerable"]:
            raise OsvCheckError("npm_lock_vulnerable_control_not_detected")
        if outputs["npm_lock_fixed"]:
            raise OsvCheckError("npm_lock_fixed_control_detected")
        ecosystem_controls = {
            "cargo": ("cargo_vulnerable", "cargo_fixed"),
            "composer": ("composer_vulnerable", "composer_fixed"),
            "go": ("go_vulnerable", "go_fixed"),
            "maven": ("maven_vulnerable", "maven_fixed"),
            "ruby": ("ruby_vulnerable", "ruby_fixed"),
        }
        for ecosystem, (vulnerable_case, fixed_case) in ecosystem_controls.items():
            if not outputs[vulnerable_case]:
                raise OsvCheckError(f"{ecosystem}_vulnerable_control_not_detected")
            if outputs[fixed_case]:
                raise OsvCheckError(f"{ecosystem}_fixed_control_detected")
        if {item.rule_id for item in outputs["npm_manifest"]} != {
            "WK-OSV-RANGED-DEPENDENCY",
            "WK-OSV-UNRESOLVED-DEPENDENCY",
        }:
            raise OsvCheckError("npm_manifest_uncertainty_control_missing")
        if {item.rule_id for item in outputs["unresolved"]} != {"WK-OSV-UNRESOLVED-DEPENDENCY"}:
            raise OsvCheckError("unresolved_control_missing")
        if {item.rule_id for item in outputs["ranged"]} != {"WK-OSV-RANGED-DEPENDENCY"}:
            raise OsvCheckError("ranged_control_missing")

        return {
            "database_bytes": database["database_bytes"],
            "provisioned_ecosystems": database["ecosystems"],
            "states": states,
            "vulnerable_advisories": len(outputs["vulnerable"]),
            "ecosystem_vulnerable_advisories": {
                ecosystem: len(outputs[vulnerable_case])
                for ecosystem, (vulnerable_case, _) in ecosystem_controls.items()
            },
            "ecosystem_fixed_findings": {
                ecosystem: len(outputs[fixed_case])
                for ecosystem, (_, fixed_case) in ecosystem_controls.items()
            },
            "fixed_findings": len(outputs["fixed"]),
            "unresolved_findings": len(outputs["unresolved"]),
            "ranged_findings": len(outputs["ranged"]),
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    try:
        result = run_check()
    except (OsvCheckError, OSError, ValueError) as error:
        print(f"OSV scanner smoke failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
