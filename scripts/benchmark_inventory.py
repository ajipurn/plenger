"""Evaluate the explicitly imported agent/model/retriever inventory corpus."""

import json
from collections import Counter
from pathlib import Path

from plenger.graph.worker import analyze

INVENTORY_KINDS = {"agent", "tool", "llm_call", "retriever"}
INVENTORY_EDGE_KINDS = {"calls", "invokes_tool", "retrieves_from"}

root = Path(__file__).resolve().parents[1]
corpus = json.loads((root / "fixtures/grammar/python-inventory-v1.json").read_text())
expected_total = actual_total = matched = 0
records = []

for case in corpus["cases"]:
    result = analyze({"fixture.py": case["source"]}, "inventory-evaluation")
    labels = {node["id"]: node["label"] for node in result["nodes"]}
    actual_nodes = Counter(
        (node["kind"], node["label"]) for node in result["nodes"] if node["kind"] in INVENTORY_KINDS
    )
    actual_edges = Counter(
        (edge["kind"], labels[edge["source"]], labels[edge["target"]])
        for edge in result["edges"]
        if edge["kind"] in INVENTORY_EDGE_KINDS
    )
    expected_nodes = Counter((node["kind"], node["label"]) for node in case["nodes"])
    expected_edges = Counter(
        (edge["kind"], edge["source"], edge["target"]) for edge in case["edges"]
    )
    case_expected = sum(expected_nodes.values()) + sum(expected_edges.values())
    case_actual = sum(actual_nodes.values()) + sum(actual_edges.values())
    case_matched = sum((expected_nodes & actual_nodes).values()) + sum(
        (expected_edges & actual_edges).values()
    )
    expected_total += case_expected
    actual_total += case_actual
    matched += case_matched
    records.append(
        {
            "case_id": case["id"],
            "expected": case_expected,
            "actual": case_actual,
            "matched": case_matched,
            "exact": expected_nodes == actual_nodes and expected_edges == actual_edges,
        }
    )

report = {
    "schema_version": 1,
    "corpus": "python-inventory-v1",
    "fixture_count": len(records),
    "inventory_kinds": sorted(INVENTORY_KINDS),
    "inventory_edge_kinds": sorted(INVENTORY_EDGE_KINDS),
    "parser": "python-ast-v2",
    "precision": matched / actual_total if actual_total else 1.0,
    "recall": matched / expected_total if expected_total else 1.0,
    "records": records,
    "limitations": [
        "Authored explicit-import corpus, not independently audited or held-out",
        (
            "Dynamic imports, runtime reachability, aliases not resolved by the supported "
            "patterns, and tool registration are unknown"
        ),
        "Results do not estimate whole-program inventory accuracy",
    ],
}
if not all(record["exact"] for record in records):
    raise SystemExit("inventory corpus mismatch: expected and observed inventory differ")

(root / "docs/inventory-results.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({key: value for key, value in report.items() if key != "records"}))
