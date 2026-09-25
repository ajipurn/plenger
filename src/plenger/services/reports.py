"""Reads, graph pages and exports of stored scan reports."""

import html
import json
from pathlib import Path
from typing import Any

from plenger.policy.redaction import redact
from plenger.services.application import project_id
from plenger.services.evidence import expire_evidence, expire_report_evidence
from plenger.services.findings import apply_suppression_state
from plenger.services.integrity import check_report
from plenger.services.workspace import load_config
from plenger.storage.assessments import list_assessments
from plenger.storage.database import latest_report_id, open_store, reports
from plenger.storage.findings import expired_evidence_ids
from plenger.storage.graph import graph_page as normalized_graph_page


def latest(root: Path, run_id: str | None = None) -> dict[str, Any] | None:
    load_config(root)
    engine = open_store(root)
    identity = project_id(root)
    try:
        expire_evidence(engine, identity)
        # Verify evidence against the stored bytes, then redact for output. Read-side
        # redaction changes must never be mistaken for evidence corruption.
        stored = reports(engine, identity, run_id, redacted=False)
        clean: dict[str, Any] | None = redact(check_report(stored)) if stored else None
        if clean:
            report_run = clean.get("run_id")
            if isinstance(report_run, str):
                expire_report_evidence(
                    clean, expired_evidence_ids(engine, identity, run_id=report_run)
                )
            apply_suppression_state(engine, identity, clean.get("findings", []))
        return clean
    finally:
        engine.dispose()


def graph_page(
    root: Path,
    limit: int = 100,
    offset: int = 0,
    requested_run_id: str | None = None,
    node_kind: str | None = None,
    source_path: str | None = None,
) -> dict[str, Any]:
    """Read one graph page from normalized storage, not the report mirror."""

    if requested_run_id is not None and (not requested_run_id or len(requested_run_id) > 128):
        raise ValueError("invalid_run_id")
    load_config(root)
    identity = project_id(root)
    engine = open_store(root)
    try:
        run_id = requested_run_id or latest_report_id(engine, identity)
        if run_id is None:
            return {"snapshot_id": None, "nodes": [], "edges": [], "next_offset": None}
        return normalized_graph_page(
            engine, identity, run_id, limit, offset, node_kind, source_path
        )
    finally:
        engine.dispose()


def export_report(report: dict[str, Any], format: str) -> str:
    data = json.dumps(redact(report), indent=2, ensure_ascii=False)
    if format == "json":
        return data
    if format == "html":
        return (
            '<!doctype html><html lang="id"><meta charset="utf-8">'
            '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;">'
            "<title>plenger report</title><h1>plenger — analisis terbatas</h1><pre>"
            + html.escape(data)
            + "</pre></html>"
        )
    raise ValueError("unsupported_export_format")


def export_stored_report(root: Path, run_id: str, format: str) -> str | None:
    """Export one stored report with complete normalized assessment history."""

    report = latest(root, run_id)
    if report is None:
        return None
    engine = open_store(root)
    try:
        report["assessments"] = list_assessments(engine, project_id(root), run_id)
    finally:
        engine.dispose()
    return export_report(report, format)
