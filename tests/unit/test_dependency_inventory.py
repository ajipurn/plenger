from pathlib import Path

from scripts.check_dependency_inventory import (
    _license_metadata,
    build_inventory,
    validate_inventory,
)


def test_dependency_inventory_binds_lockfiles_and_engine_digests():
    root = Path(__file__).resolve().parents[2]
    inventory = build_inventory(root)

    assert validate_inventory(inventory) == []
    assert {item["name"] for item in inventory["managed_engines"]} == {
        "osv",
        "semgrep",
        "trivy",
    }
    assert any(item["name"] == "fastapi" for item in inventory["python"]["packages"])
    assert any(item["name"] == "react" for item in inventory["frontend"]["packages"])


def test_dependency_inventory_reports_tampered_identity():
    root = Path(__file__).resolve().parents[2]
    inventory = build_inventory(root)
    inventory["managed_engines"][0]["sha256"] = ["sha256:invalid"]

    assert any("digest_missing_or_invalid" in item for item in validate_inventory(inventory))


def test_dependency_inventory_accepts_pep639_license_expression(monkeypatch):
    class FakeMetadata:
        def get_all(self, key):
            return ["MIT"] if key == "License-Expression" else []

    monkeypatch.setattr(
        "scripts.check_dependency_inventory.metadata.metadata",
        lambda name: FakeMetadata(),
    )

    assert _license_metadata("pep639-fixture") == {
        "status": "declared",
        "declared": ["MIT"],
    }
