from pathlib import Path

from langchain_core.tools import tool

NOTES = Path("/srv/notes").resolve()


@tool
def read_note(name: str) -> str:
    """Read a note for the user."""
    target = (NOTES / name).resolve()
    if not target.is_relative_to(NOTES) or not target.is_file():
        raise ValueError("note not found")
    return target.read_text(encoding="utf-8")
