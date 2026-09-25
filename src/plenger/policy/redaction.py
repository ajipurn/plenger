"""Output minimization and conservative redaction, independent of model decisions."""

import re
from typing import Any

PATTERNS = [
    # Credential prefixes are case-sensitive and must be followed by their own
    # delimiter, so identifiers and paths such as ``sklearn_utils.py`` or
    # ``skip-tls-verify`` are left intact while ``sk-…``/``ghp_…`` keys are not.
    re.compile(
        r"(?<![A-Za-z0-9])(?:"
        r"sk-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{16,}"
        r"|sk_(?:live|test)_[A-Za-z0-9]{16,}"
        r"|gh[pousr]_[A-Za-z0-9]{20,}"
        r"|github_pat_[A-Za-z0-9_]{20,}"
        r"|(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Za-z])"
        r")"
    ),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*"),
    re.compile(
        r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----"
        r"(?:[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|[\s\S]*)"
    ),
    re.compile(r"(?i)(?:secret|password|token|api_key)\s*[=:]\s*[^\s,;]+"),
    re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}"),
]
SENSITIVE_FIELD_NAMES = {
    "access_token",
    "api_key",
    "apikey",
    "authorization",
    "client_secret",
    "cookie",
    "id_token",
    "password",
    "passwd",
    "private_key",
    "refresh_token",
    "secret",
    "set_cookie",
    "token",
}


def _is_sensitive_field(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    camel_case = re.sub(r"(?<!^)(?=[A-Z])", "_", value)
    normalized = re.sub(r"[^a-z0-9]+", "_", camel_case.casefold()).strip("_")
    return (
        normalized in SENSITIVE_FIELD_NAMES
        or normalized.startswith(("secret_", "password_", "api_key_"))
        or normalized.endswith(("_secret", "_password", "_passwd", "_token", "_api_key"))
    )


def redact(value: Any) -> Any:
    if isinstance(value, str):
        for pattern in PATTERNS:
            value = pattern.sub("[REDACTED]", value)
        return value
    if isinstance(value, dict):
        return {
            redact(k): "[REDACTED]" if _is_sensitive_field(k) else redact(v)
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value
