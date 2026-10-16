from langchain_core.tools import tool


@tool
def read_note(path: str) -> str:
    """Read a note for the user."""
    with open(path, encoding="utf-8") as handle:
        return handle.read()
