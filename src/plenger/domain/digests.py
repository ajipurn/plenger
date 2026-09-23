"""Canonical JSON identities shared by domain contracts and storage."""

import hashlib
import json
from typing import Any


def digest(value: Any) -> str:
    """Return the stable SHA-256 identity of a JSON-compatible value."""

    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()
