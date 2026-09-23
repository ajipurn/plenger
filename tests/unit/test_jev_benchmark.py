import json
from pathlib import Path


def test_jev_benchmark_corpus_is_bilingual_and_split():
    root = Path(__file__).resolve().parents[2]
    corpus = json.loads((root / "fixtures/evaluator/jev-local-v1.json").read_text())
    cases = corpus["cases"]
    assert len(cases) == 120
    assert {case["language"] for case in cases} == {"en", "id"}
    assert {case["split"] for case in cases} == {"tuning", "holdout"}
    assert sum(case["adversarial"] for case in cases) >= 40
    assert {case["outcome"] for case in cases} >= {
        "valid",
        "schema_error",
        "rate_limited",
        "timeout",
    }
