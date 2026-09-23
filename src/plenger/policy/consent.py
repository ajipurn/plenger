"""Shared validation for granular hosted-consent scopes."""

from __future__ import annotations

from collections.abc import Iterable

HOSTED_DATA_CLASSES = frozenset({"metadata", "code_excerpt", "prompt", "response", "trace"})


def normalize_data_classes(values: Iterable[str]) -> tuple[str, ...]:
    """Return a stable, bounded scope or reject an invalid consent request."""

    items = list(values)
    if not 1 <= len(items) <= len(HOSTED_DATA_CLASSES):
        raise ValueError("invalid_consent_data_classes")
    if any(not isinstance(item, str) or not item for item in items):
        raise ValueError("invalid_consent_data_classes")
    if any(item not in HOSTED_DATA_CLASSES for item in items):
        raise ValueError("invalid_consent_data_classes")
    if len(set(items)) != len(items):
        raise ValueError("invalid_consent_data_classes")
    return tuple(sorted(items))
