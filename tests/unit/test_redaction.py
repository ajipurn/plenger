import pytest

from plenger.policy import redact


@pytest.mark.parametrize(
    "value",
    [
        "src/skeleton_generator.py",
        "app/task_skip_validation_handler.py",
        "sklearn_pipeline_model.py",
        "python.lang.security.audit.skip-tls-verify-check",
        "Skipped_because_unsupported",
        "PLENGER_SYNTHETIC_DISCLOSURE_MARKER",
        "components/sk-button.tsx",
        "max_tokens: 100",
    ],
)
def test_structural_identifiers_are_not_mistaken_for_credentials(value):
    assert redact(value) == value


@pytest.mark.parametrize(
    "value",
    [
        "sk-proj-Abc123def456GHI789jkl012",
        "sk-synthetic-run-secret123456",
        "sk_live_" + "Ab1" * 8,
        "ghp_" + "a1B2" * 9,
        "github_pat_" + "11AB" * 8,
        "AKIAIOSFODNN7EXAMPLE",
        "Authorization: Bearer abcdefghijklmnop1234",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
        "password = hunter2",
        "reach me at admin@example.com",
    ],
)
def test_credentials_and_contact_data_are_redacted(value):
    redacted = redact(value)
    assert "[REDACTED]" in redacted
    for fragment in ("Abc123", "secret123456", "Ab1Ab1", "a1B2a1B2", "11AB11AB"):
        assert fragment not in redacted
    assert "IOSFODNN7" not in redacted
    assert "MIIEpAIBAAKCAQEA" not in redacted
    assert "hunter2" not in redacted
    assert "admin@example.com" not in redacted


def test_sensitive_field_names_are_redacted_regardless_of_value():
    assert redact({"clientSecret": "plain", "path": "sk_utils.py"}) == {
        "clientSecret": "[REDACTED]",
        "path": "sk_utils.py",
    }
