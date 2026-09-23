import json
from collections import Counter
from pathlib import Path

from plenger.domain.parser import ParserResult
from plenger.graph.worker import analyze

CORPUS = json.loads(
    (Path(__file__).parents[2] / "fixtures/grammar/python-inventory-v1.json").read_text()
)
INVENTORY_KINDS = {"agent", "tool", "llm_call", "retriever"}
INVENTORY_EDGE_KINDS = {"calls", "invokes_tool", "retrieves_from"}


def test_explicit_inventory_corpus_matches_expected_nodes_and_edges():
    assert len(CORPUS["cases"]) >= 10
    assert sum(bool(case["nodes"]) for case in CORPUS["cases"]) >= 10
    for case in CORPUS["cases"]:
        result = analyze({"fixture.py": case["source"]}, "inventory-test")
        ParserResult.model_validate(result)
        labels = {node["id"]: node["label"] for node in result["nodes"]}
        actual_nodes = Counter(
            (node["kind"], node["label"])
            for node in result["nodes"]
            if node["kind"] in INVENTORY_KINDS
        )
        actual_edges = Counter(
            (edge["kind"], labels[edge["source"]], labels[edge["target"]])
            for edge in result["edges"]
            if edge["kind"] in INVENTORY_EDGE_KINDS
        )
        assert actual_nodes == Counter((node["kind"], node["label"]) for node in case["nodes"])
        assert actual_edges == Counter(
            (edge["kind"], edge["source"], edge["target"]) for edge in case["edges"]
        )
