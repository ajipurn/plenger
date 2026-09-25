"""Repeat the local parser and findings-page performance checks.

This benchmark uses only generated data and the pinned local parser image.  It
does not import or execute a target project, contact a hosted service, or use
scanner databases.  Results are evidence for this host, not release claims.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import statistics
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import text

from plenger.adapters import IMAGE, execute, probe
from plenger.api import ORIGIN, create_app
from plenger.services.application import execute_scan, findings_page, project_id, queue_scan
from plenger.services.workspace import initialize
from plenger.storage.database import open_store, save_report
from plenger.storage.findings import persist_report_entities
from plenger.storage.runs import create_run


def _p95(values: list[float]) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * 0.95) - 1)]


def _physical_memory_bytes() -> int | None:
    try:
        pages = os.sysconf("SC_PHYS_PAGES")
        page_size = os.sysconf("SC_PAGE_SIZE")
    except (ValueError, OSError):
        return None
    if not isinstance(pages, int) or not isinstance(page_size, int) or pages <= 0 or page_size <= 0:
        return None
    return pages * page_size


def _source() -> str:
    blocks = []
    for index in range(2000):
        blocks.append(
            "\n".join(
                (
                    f"def benchmark_function_{index}(value):",
                    "    first = value",
                    f"    second = first + {index}",
                    "    return second",
                )
            )
        )
    return "\n\n".join(blocks) + "\n# generated benchmark sentinel\n"


def _seed_findings(root: Path, count: int = 5000) -> None:
    engine = open_store(root)
    identity = project_id(root)
    run_id, _ = create_run(engine, identity, "deterministic", False, "a" * 64, "benchmark")
    snapshot_id = str(uuid.uuid4())
    report: dict[str, Any] = {
        "run_id": run_id,
        "project_id": identity,
        "snapshot_id": snapshot_id,
        "findings": [],
    }
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO snapshots "
                    "(id,run_id,project_id,manifest_digest,payload) "
                    "VALUES (:id,:run,:project,:digest,:payload)"
                ),
                {
                    "id": snapshot_id,
                    "run": run_id,
                    "project": identity,
                    "digest": "b" * 64,
                    "payload": "{}",
                },
            )
            for index in range(count):
                finding_id = hashlib.sha256(f"finding-{index}".encode()).hexdigest()
                evidence_id = hashlib.sha256(f"evidence-{index}".encode()).hexdigest()
                report["findings"].append(
                    {
                        "id": finding_id,
                        "fingerprint": hashlib.sha256(f"fingerprint-{index}".encode()).hexdigest(),
                        "rule_id": "WK-BENCH-001",
                        "kind": "benchmark",
                        "severity": "low",
                        "severity_source": "benchmark",
                        "validation_state": "candidate",
                        "lifecycle_state": "open",
                        "assessment_state": "needs_review",
                        "title": "Synthetic benchmark finding",
                        "source_ref": {"path": f"benchmark/{index % 100}.py", "line": index + 1},
                        "evidence": {
                            "id": evidence_id,
                            "source": "benchmark",
                            "observed": "synthetic benchmark evidence",
                            "redaction_version": "benchmark-v1",
                            "sha256_redacted": hashlib.sha256(evidence_id.encode()).hexdigest(),
                        },
                    }
                )
            persist_report_entities(connection, report)
        save_report(engine, report)
    finally:
        engine.dispose()


def run(runs: int) -> dict[str, Any]:
    capability = probe()
    if capability.get("status") != "ready":
        raise RuntimeError("sandbox_unavailable")
    source = _source()
    parser_times: list[float] = []
    warm_scan_times: list[float] = []
    startup_times: list[float] = []
    with tempfile.TemporaryDirectory(prefix="plenger-performance-") as temporary:
        root = Path(temporary)
        initialize(root)
        (root / "benchmark.py").write_text(source, encoding="utf-8")
        for _ in range(runs):
            started = time.perf_counter()
            result = execute({"benchmark.py": source}, "performance-benchmark")
            parser_times.append(time.perf_counter() - started)
            if result["errors"]:
                raise RuntimeError("benchmark_parser_error")
        for index in range(runs):
            run_id, _ = queue_scan(
                root,
                "deterministic",
                False,
                f"performance-warm-{index}-{uuid.uuid4().hex}",
            )
            started = time.perf_counter()
            report = execute_scan(root, run_id)
            warm_scan_times.append(time.perf_counter() - started)
            if report["state"] != "completed":
                raise RuntimeError("benchmark_warm_scan_error")
        for _ in range(runs):
            started = time.perf_counter()
            with TestClient(create_app(root), base_url=ORIGIN) as client:
                response = client.get("/")
            startup_times.append(time.perf_counter() - started)
            if response.status_code != 200:
                raise RuntimeError("benchmark_startup_error")
        _seed_findings(root)
        listing_times: list[float] = []
        for _ in range(runs):
            started = time.perf_counter()
            page = findings_page(root, limit=100, offset=2500)
            listing_times.append(time.perf_counter() - started)
            if len(page) != 100:
                raise RuntimeError("benchmark_listing_page_invalid")
    return {
        "schema_version": 1,
        "runs": runs,
        "host": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "cpu_count": os.cpu_count(),
            "memory_bytes": _physical_memory_bytes(),
        },
        "worker_image": IMAGE,
        "cache_state": {
            "worker_image": "present_before_run",
            "workspace": "fresh_temporary_workspace",
            "host_os_cache": "uncontrolled",
        },
        "input": {"loc": source.count("\n"), "bytes": len(source.encode()), "files": 1},
        "parser_seconds": {
            "p50": statistics.median(parser_times),
            "p95": _p95(parser_times),
            "samples": parser_times,
        },
        "warm_scan_seconds": {
            "p50": statistics.median(warm_scan_times),
            "p95": _p95(warm_scan_times),
            "samples": warm_scan_times,
            "profile": "deterministic",
            "worker_image": IMAGE,
        },
        "application_startup_seconds": {
            "p50": statistics.median(startup_times),
            "p95": _p95(startup_times),
            "samples": startup_times,
            "probe": "TestClient app lifespan plus GET / asset response",
        },
        "findings_page_seconds": {
            "p50": statistics.median(listing_times),
            "p95": _p95(listing_times),
            "samples": listing_times,
            "finding_count": 5000,
            "page_size": 100,
        },
        "limitations": [
            "Generated benchmark data, not a customer repository",
            "Host-local measurements; no cold-install, browser-render, or cross-platform claim",
            "Parser benchmark uses the pinned deterministic worker only",
            "Warm scan uses the deterministic profile and does not include third-party scanners",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--output", type=Path, default=Path("docs/performance-results.json"))
    args = parser.parse_args()
    if not 20 <= args.runs <= 100:
        parser.error("--runs must be between 20 and 100")
    try:
        result = run(args.runs)
    except RuntimeError as exc:
        print(json.dumps({"status": "blocked", "reason": str(exc)}))
        raise SystemExit(3) from None
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in result.items() if key != "host"}))


if __name__ == "__main__":
    main()
