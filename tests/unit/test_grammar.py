"""Labeled corpus: expected semantics are hand-authored, never derived by importing fixtures."""

import json
from collections import Counter
from pathlib import Path

import pytest

from plenger.domain.parser import ParserResult
from plenger.graph.worker import analyze

FIXTURE_ROOT = Path(__file__).parents[2] / "fixtures/grammar"
CORPORA = {
    "tuning": json.loads((FIXTURE_ROOT / "python-fastapi-v1.json").read_text()),
    "holdout": json.loads((FIXTURE_ROOT / "python-fastapi-holdout-v1.json").read_text()),
}
CASES = [(split, case) for split, corpus in CORPORA.items() for case in corpus["cases"]]


def expected_graph(case):
    nodes = Counter(
        [("file", "fixture.py")]
        + [("symbol", symbol) for symbol in case["symbols"]]
        + [("endpoint", label) for _, label in case["endpoints"]]
    )
    edges = Counter(
        [
            (symbol.rsplit(".", 1)[0] if "." in symbol else "fixture.py", symbol)
            for symbol in case["symbols"]
        ]
        + [tuple(item) for item in case["endpoints"]]
    )
    return nodes, edges


def actual_graph(result):
    labels = {node["id"]: node["label"] for node in result["nodes"]}
    return (
        Counter((node["kind"], node["label"]) for node in result["nodes"]),
        Counter((labels[edge["source"]], labels[edge["target"]]) for edge in result["edges"]),
    )


def test_grammar_case_ids_are_unique_across_splits():
    case_ids = [case["id"] for _, case in CASES]
    assert len(case_ids) == len(set(case_ids))


@pytest.mark.parametrize(
    ("split", "case"), CASES, ids=[f"{split}-{case['id']}" for split, case in CASES]
)
def test_labeled_mapping(split, case):
    result = analyze({"fixture.py": case["source"]}, "corpus")
    ParserResult.model_validate(result)
    assert actual_graph(result) == expected_graph(case)
    assert len(result["findings"]) == case["findings"]
    assert len(result["errors"]) == case["errors"]
    assert all(
        edge["source_ref"]["line"] > 0 and edge["provenance"] == "observed_static"
        for edge in result["edges"]
    )
