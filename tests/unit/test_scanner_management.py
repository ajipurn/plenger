import hashlib
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from plenger.adapters.scanners import SCANNER_CONTAINER_IMAGES, ScannerExecutionError
from plenger.services.scanners import (
    DatabaseMetadata,
    ManagedScanner,
    ManagedScannerManifest,
    _database_fingerprint,
    _ensure_private_directory,
    _stage_files,
    load_scanner_manifest,
    provision_osv_database,
    provision_scanners,
    save_scanner_manifest,
    scanner_capabilities,
)
from plenger.services.workspace import initialize


def test_scanner_staging_is_owner_only_and_verified(tmp_path):
    with _stage_files({"nested/input.txt": "synthetic input\n"}) as staged:
        assert staged.stat().st_mode & 0o777 == 0o700
        copied = staged / "nested" / "input.txt"
        assert copied.read_text() == "synthetic input\n"
        assert copied.stat().st_mode & 0o777 == 0o600


def test_scanner_private_directory_is_opened_once_and_closed(tmp_path, monkeypatch):
    opened: list[tuple[object, bool]] = []
    closed: list[int] = []

    monkeypatch.setattr(
        "plenger.services.scanners._private_dir",
        lambda root, *, create: opened.append((root, create)) or 41,
    )
    monkeypatch.setattr("plenger.services.scanners.os.close", closed.append)

    _ensure_private_directory(tmp_path)

    assert opened == [(tmp_path, True)]
    assert closed == [41]


def test_host_manifest_is_unavailable_when_container_worker_is_required(tmp_path, monkeypatch):
    runtime, entry = _managed_osv_fixture(tmp_path)
    save_scanner_manifest(tmp_path, ManagedScannerManifest(engines=[entry]))
    monkeypatch.setattr(
        "plenger.services.scanners.scanner_isolation_mode",
        lambda: "docker_pinned",
    )

    status = scanner_capabilities(tmp_path)["osv"]

    assert runtime.is_dir()
    assert status["status"] == "unavailable"
    assert status["reason"] == "container_worker_required"


def test_container_manifest_is_unavailable_without_non_root_user(tmp_path, monkeypatch):
    initialize(tmp_path)
    entry = ManagedScanner(
        name="trivy",
        version="0.74.0",
        container_image=(
            "aquasec/trivy@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969"
        ),
    )
    save_scanner_manifest(tmp_path, ManagedScannerManifest(engines=[entry]))
    monkeypatch.setattr(
        "plenger.services.scanners.container_runtime_mode",
        lambda: "docker_pinned",
    )
    monkeypatch.setattr(
        "plenger.services.scanners.container_user_available",
        lambda: False,
    )

    status = scanner_capabilities(tmp_path)["trivy"]

    assert status["status"] == "unavailable"
    assert status["reason"] == "container_non_root_user_unavailable"


def test_container_provisioning_can_pull_missing_pinned_image(tmp_path, monkeypatch):
    initialize(tmp_path)
    image = SCANNER_CONTAINER_IMAGES["semgrep"]
    present: set[str] = set()
    monkeypatch.setattr("plenger.services.scanners.container_runtime_mode", lambda: "docker_pinned")
    monkeypatch.setattr("plenger.services.scanners.container_user_available", lambda: True)
    monkeypatch.setattr(
        "plenger.services.scanners.container_image_present", lambda value: value in present
    )
    monkeypatch.setattr(
        "plenger.services.scanners.pull_container_image",
        lambda value: (present.add(value) or True, "container_image_pulled"),
    )
    monkeypatch.setattr(
        "plenger.services.scanners.container_version_probe", lambda name, value: "1.176.0"
    )

    result = provision_scanners(tmp_path, ["semgrep"], container=True, pull=True)

    assert result["engines"]["semgrep"]["status"] == "ready"
    assert result["engines"]["semgrep"]["reason"] == "container_image_pulled"
    assert load_scanner_manifest(tmp_path).engines[0].container_image == image


def test_osv_provisioning_preserves_safe_scanner_failure_reason(tmp_path, monkeypatch):
    initialize(tmp_path)
    save_scanner_manifest(
        tmp_path,
        ManagedScannerManifest(
            engines=[
                ManagedScanner(
                    name="osv",
                    version="2.6.0",
                    container_image=SCANNER_CONTAINER_IMAGES["osv"],
                )
            ]
        ),
    )
    monkeypatch.setattr(
        "plenger.services.scanners._verify_binary",
        lambda entry: ("ready", "managed", {"isolation": "docker_pinned"}),
    )
    monkeypatch.setattr(
        "plenger.services.scanners.plan_scanner",
        lambda engine, target_root, **kwargs: SimpleNamespace(container_image=None),
    )

    def fail_with_safe_reason(plan):
        raise ScannerExecutionError("scanner_timeout")

    monkeypatch.setattr("plenger.services.scanners._bounded_process", fail_with_safe_reason)

    result = provision_osv_database(tmp_path)

    assert result == {"status": "unavailable", "reason": "osv_database_scanner_timeout"}


@pytest.mark.parametrize(
    ("input_name", "expected_fixture"),
    [
        ("package-lock.json", "package-lock.json"),
        ("package.json", "package-lock.json"),
        ("Cargo.lock", "Cargo.lock"),
        ("go.mod", "go.mod"),
        ("Gemfile.lock", "Gemfile.lock"),
        ("composer.lock", "composer.lock"),
        ("pom.xml", "pom.xml"),
    ],
)
def test_osv_provisioning_stages_ecosystem_fixture_for_nested_input(
    tmp_path, monkeypatch, input_name, expected_fixture
):
    initialize(tmp_path)
    (tmp_path / "web").mkdir()
    (tmp_path / "web" / input_name).write_text("{}")
    save_scanner_manifest(
        tmp_path,
        ManagedScannerManifest(
            engines=[
                ManagedScanner(
                    name="osv",
                    version="2.6.0",
                    container_image=SCANNER_CONTAINER_IMAGES["osv"],
                )
            ]
        ),
    )
    staged: dict[str, list[str]] = {}
    monkeypatch.setattr(
        "plenger.services.scanners._verify_binary",
        lambda entry: ("ready", "managed", {"isolation": "docker_pinned"}),
    )

    def fake_plan(engine, target_root, **kwargs):
        staged["files"] = sorted(
            path.relative_to(target_root).as_posix()
            for path in target_root.rglob("*")
            if path.is_file()
        )
        return SimpleNamespace(container_image=None)

    monkeypatch.setattr("plenger.services.scanners.plan_scanner", fake_plan)
    monkeypatch.setattr(
        "plenger.services.scanners._bounded_process",
        lambda plan: b'{"results":[]}',
    )
    monkeypatch.setattr(
        "plenger.services.scanners._database_fingerprint",
        lambda home: ("a" * 64, 1),
    )

    result = provision_osv_database(tmp_path)

    assert result["status"] == "ready"
    assert "python" in result["ecosystems"]
    assert expected_fixture in staged["files"]
    assert staged["files"][-1] == "requirements.txt"


def _managed_osv_fixture(tmp_path):
    initialize(tmp_path)
    binary = tmp_path / "osv-scanner"
    binary.write_text("#!/bin/sh\nprintf '2.6.0\\n'\n")
    binary.chmod(0o700)
    runtime = tmp_path / ".plenger" / "scanners" / "osv"
    runtime.mkdir(parents=True, mode=0o700)
    (tmp_path / ".plenger").chmod(0o700)
    (tmp_path / ".plenger" / "scanners").chmod(0o700)
    runtime.chmod(0o700)
    (runtime / "database.bin").write_bytes(b"local-advisory-data")
    fingerprint, size_bytes = _database_fingerprint(runtime)
    assert fingerprint is not None
    entry = ManagedScanner(
        name="osv",
        executable=str(binary),
        version="2.6.0",
        binary_hash=hashlib.sha256(binary.read_bytes()).hexdigest(),
        database=DatabaseMetadata(
            provisioned_at=datetime.now(UTC).isoformat(),
            fingerprint=fingerprint,
            size_bytes=size_bytes,
        ),
    )
    return runtime, entry


def test_osv_database_staleness_is_unavailable(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "plenger.services.scanners.scanner_isolation_mode",
        lambda: "seatbelt_default_deny",
    )
    runtime, entry = _managed_osv_fixture(tmp_path)
    entry = entry.model_copy(
        update={
            "database": entry.database.model_copy(
                update={"provisioned_at": (datetime.now(UTC) - timedelta(days=8)).isoformat()}
            )
        }
    )
    save_scanner_manifest(tmp_path, ManagedScannerManifest(engines=[entry]))

    status = scanner_capabilities(tmp_path)["osv"]

    assert runtime.is_dir()
    assert status["status"] == "unavailable"
    assert status["reason"] == "osv_database_stale"
    assert status["age_days"] == "8"


def test_osv_database_changes_are_unavailable(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "plenger.services.scanners.scanner_isolation_mode",
        lambda: "seatbelt_default_deny",
    )
    runtime, entry = _managed_osv_fixture(tmp_path)
    entry = entry.model_copy(
        update={"database": entry.database.model_copy(update={"fingerprint": "0" * 64})}
    )
    save_scanner_manifest(tmp_path, ManagedScannerManifest(engines=[entry]))

    status = scanner_capabilities(tmp_path)["osv"]

    assert status["status"] == "unavailable"
    assert status["reason"] == "osv_database_changed"
