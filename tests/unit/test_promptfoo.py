import json

import pytest

from plenger.adapters.promptfoo import (
    PromptfooImportError,
    import_promptfoo,
    replay_fixed_cases,
)


def test_promptfoo_import_is_bounded_and_redacted():
    result = import_promptfoo(
        json.dumps(
            {
                "results": [
                    {
                        "id": "LLM01",
                        "provider": "fixture-provider",
                        "status": "passed",
                        "response": "sk-secret-SYNTHETIC0123456789",
                        "assertions": [{"passed": True}],
                    }
                ]
            }
        )
    )
    assert result.status == "completed"
    assert result.results[0].status == "pass"
    assert "SYNTHETIC" not in result.results[0].output_excerpt
    assert result.results[0].assertion_count == 1


@pytest.mark.parametrize(
    "payload",
    [
        "[]",
        '{"results":[{"id":"x","status":"unknown"}]}',
        '{"results":[{"status":"passed"}]}',
    ],
)
def test_promptfoo_import_fails_closed(payload):
    with pytest.raises(PromptfooImportError):
        import_promptfoo(payload)


def test_promptfoo_import_never_accepts_provider_as_execution_instruction():
    result = import_promptfoo(
        json.dumps(
            {
                "results": [
                    {
                        "id": "x",
                        "provider": "file://repository/evil.py",
                        "status": "passed",
                    }
                ]
            }
        )
    )
    assert result.results[0].provider_ref.startswith("file://")


def test_promptfoo_replay_uses_only_the_supplied_broker(monkeypatch):
    broker = object()
    plan = object()
    received = {}

    def run_native_cases(actual_broker, actual_plan):
        received["broker"] = actual_broker
        received["plan"] = actual_plan
        return [{"case_id": "LLM01-direct-policy", "result": "pass"}]

    monkeypatch.setattr("plenger.adapters.promptfoo.run_fixed_cases", run_native_cases)

    result = replay_fixed_cases(broker, plan)

    assert received == {"broker": broker, "plan": plan}
    assert result == [
        {
            "case_id": "LLM01-direct-policy",
            "result": "pass",
            "source": "plenger-native-replay",
        }
    ]
