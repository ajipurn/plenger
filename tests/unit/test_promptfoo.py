import json

import pytest

from plenger.adapters.promptfoo import PromptfooImportError, import_promptfoo


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
