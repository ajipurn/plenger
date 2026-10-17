import os

from langchain_core.tools import tool

NOTES = os.path.realpath("notes")


@tool
def read_note(name: str) -> str:
    """Read a note."""
    path = os.path.realpath(os.path.join(NOTES, name))
    if not path.startswith(NOTES):
        raise ValueError("outside the notes directory")
    with open(path, encoding="utf-8") as handle:
        return handle.read()
