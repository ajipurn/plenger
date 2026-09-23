"""Conservative comparison of static reports within one project."""

import json
from typing import Any

_REPORT_IDENTITY_FIELDS = ("parser", "image", "worker_sha256", "rule_digest", "profile_digest")
_SCANNER_IDENTITY_FIELDS = (
    "name",
    "adapter_version",
    "engine_version",
    "image_digest",
    "binary_hash",
    "license_ref",
    "output_schema",
    "supported_modes",
    "supported_patterns",
    "required_network",
    "max_output_bytes",
)
_ENGINE_STATE_IDENTITY_FIELDS = ("status", "version", "binary_hash", "image_digest", "isolation")


def _selected_fields(value: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return {field: value[field] for field in fields if field in value}


def _scanner_identities(report: dict[str, Any]) -> list[dict[str, Any]]:
    results = report.get("scanner_results")
    if not isinstance(results, list):
        return []
    identities: list[dict[str, Any]] = []
    for result in results:
        if not isinstance(result, dict):
            identities.append({"invalid": True})
            continue
        manifest = result.get("manifest")
        identity = _selected_fields(manifest, _SCANNER_IDENTITY_FIELDS)
        if not identity:
            identity = {"name": result.get("engine"), "manifest": None}
        identities.append(identity)
    return sorted(identities, key=lambda item: json.dumps(item, sort_keys=True, default=str))


def _engine_state_identities(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    states = report.get("engine_states")
    if not isinstance(states, dict):
        return {}
    return {
        str(name): _selected_fields(state, _ENGINE_STATE_IDENTITY_FIELDS)
        for name, state in sorted(states.items(), key=lambda item: str(item[0]))
        if isinstance(state, dict)
    }


def _analysis_identity(report: dict[str, Any]) -> dict[str, Any]:
    manifest = report.get("manifest")
    return {
        "report": _selected_fields(manifest, _REPORT_IDENTITY_FIELDS),
        "scanner_results": _scanner_identities(report),
        "engine_states": _engine_state_identities(report),
        "profile_digest": report.get("profile_digest"),
    }


def diff_reports(base: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    if base.get("project_id") != current.get("project_id"):
        return {"comparable": False, "reason": "project_mismatch", "items": []}
    if base.get("profile") != current.get("profile"):
        return {"comparable": False, "reason": "profile_changed", "items": []}
    if base.get("manifest", {}).get("parser") != current.get("manifest", {}).get("parser"):
        return {"comparable": False, "reason": "parser_changed", "items": []}
    if _analysis_identity(base) != _analysis_identity(current):
        return {"comparable": False, "reason": "analysis_identity_changed", "items": []}
    old = {item.get("fingerprint"): item for item in base.get("findings", [])}
    new = {item.get("fingerprint"): item for item in current.get("findings", [])}
    items: list[dict[str, Any]] = []
    for fingerprint, finding in new.items():
        if fingerprint in old:
            previous_lifecycle = old[fingerprint].get("lifecycle_state")
            current_lifecycle = finding.get("lifecycle_state", "open")
            status = (
                "reopened"
                if previous_lifecycle in {"resolved", "suppressed"} and current_lifecycle == "open"
                else "recurring"
            )
        else:
            status = "new"
        items.append(
            {
                "fingerprint": fingerprint,
                "status": status,
                "base_finding_id": old.get(fingerprint, {}).get("id"),
                "current_finding_id": finding.get("id"),
            }
        )
    current_complete = current.get("state") == "completed" and not current.get("errors")
    for fingerprint, finding in old.items():
        if fingerprint in new:
            continue
        items.append(
            {
                "fingerprint": fingerprint,
                "status": "resolved" if current_complete else "not_observed",
                "base_finding_id": finding.get("id"),
                "current_finding_id": None,
            }
        )
    return {
        "comparable": True,
        "reason": "same_profile_and_parser",
        "base_run_id": base.get("run_id"),
        "current_run_id": current.get("run_id"),
        "items": sorted(items, key=lambda item: (item["status"], item["fingerprint"] or "")),
    }
