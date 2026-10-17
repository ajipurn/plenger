from pathlib import Path

from langchain_core.tools import tool

WORKDIR = Path("workdir").resolve()


@tool
def save_page(path: str, content: str) -> str:
    """Save a page under the working directory."""
    if ".." in path or path.startswith("/"):
        return "the path must stay inside the working directory"
    target = WORKDIR / path
    with open(target, "w", encoding="utf-8") as handle:
        handle.write(content)
    return "saved"
