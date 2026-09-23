"""Output minimization and conservative redaction, independent of model decisions."""

import re
from typing import Any

PATTERNS = [
    re.compile(r"(?i)(?<![A-Za-z0-9])(?:sk|ghp|github_pat|AKIA)[-_a-zA-Z0-9]{12,}"),
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
