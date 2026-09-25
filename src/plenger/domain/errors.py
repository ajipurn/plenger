"""Stable error codes shared by the CLI and the HTTP API."""

import re

_SAFE_CODE = re.compile(r"[a-z][a-z0-9_]{0,63}")


def safe_code(exc: Exception, fallback: str) -> str:
    """Expose an exception's own stable error code, never free-form messages."""

    code = str(exc)
    return code if _SAFE_CODE.fullmatch(code) else fallback
