"""Shared pytest configuration.

Each test is marked after the directory it lives in, so a quick local loop can
run `pytest -m "not integration"` while CI-style gates run everything.
"""

from pathlib import Path

import pytest

_DIRECTORY_MARKERS = {"unit", "security", "integration"}


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    tests_root = Path(__file__).parent
    for item in items:
        relative = Path(item.path).relative_to(tests_root)
        if relative.parts and relative.parts[0] in _DIRECTORY_MARKERS:
            item.add_marker(relative.parts[0])
