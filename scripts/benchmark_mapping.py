"""Evaluate the checked-in labeled grammar and holdout corpora."""

import json
from collections import Counter
from pathlib import Path
from typing import Any

from plenger.graph.worker import analyze

root = Path(__file__).resolve().parents[1]
corpus_paths = {
    "tuning": root / "fixtures/grammar/python-fastapi-v1.json",
    "holdout": root / "fixtures/grammar/python-fastapi-holdout-v1.json",
}


def evaluate_corpus(split: str, corpus: dict[str, Any]) -> dict[str, Any]:
    matched = expected_total = actual_total = 0
    records = []
    for case in corpus["cases"]:
        result = analyze({"fixture.py": case["source"]}, f"mapping-{split}")
        expected = Counter(
            [("file", "fixture.py")]
            + [("symbol", name) for name in case["symbols"]]
            + [("endpoint", label) for _, label in case["endpoints"]]
        )
        actual = Counter((node["kind"], node["label"]) for node in result["nodes"])
        labels = {node["id"]: node["label"] for node in result["nodes"]}
        expected_edges = Counter(
            [
                ("defines", name.rsplit(".", 1)[0] if "." in name else "fixture.py", name)
                for name in case["symbols"]
            ]
            + [("defines", handler, label) for handler, label in case["endpoints"]]
        )
        actual_edges = Counter(
            (edge["kind"], labels[edge["source"]], labels[edge["target"]])
            for edge in result["edges"]
        )
        correct = sum((expected & actual).values()) + sum((expected_edges & actual_edges).values())
        expected_count = sum(expected.values()) + sum(expected_edges.values())
        actual_count = sum(actual.values()) + sum(actual_edges.values())
        matched += correct
        expected_total += expected_count
        actual_total += actual_count
        records.append(
            {
                "split": split,
                "case_id": case["id"],
                "expected": expected_count,
                "actual": actual_count,
                "matched": correct,
            }
        )
    return {
        "fixture_count": len(records),
        "precision": matched / actual_total,
        "recall": matched / expected_total,
        "records": records,
    }


splits = {
    split: evaluate_corpus(split, json.loads(path.read_text()))
    for split, path in corpus_paths.items()
}
records = [record for result in splits.values() for record in result["records"]]
matched = sum(record["matched"] for record in records)
expected_total = sum(record["expected"] for record in records)
actual_total = sum(record["actual"] for record in records)
report = {
    "schema_version": 1,
    "corpus": "python-fastapi-v1-with-holdout",
    "fixture_count": len(records),
    "parser": "python-ast-v2",
    "precision": matched / actual_total,
    "recall": matched / expected_total,
    "splits": {
        split: {key: value for key, value in result.items() if key != "records"}
        for split, result in splits.items()
    },
    "records": records,
    "limitations": [
        "Tuning and holdout cases are authored in this repository, not independently audited",
        "Only stated definition/route grammar; no agent or runtime coverage",
        "Results do not estimate vulnerability detection accuracy",
    ],
}
output = root / "docs/mapping-results.json"
output.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({key: value for key, value in report.items() if key not in {"records"}}))
