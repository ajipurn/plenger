from pathlib import Path

from langchain_core.tools import tool

REPORTS = Path("reports").resolve()


@tool
def save_report(title: str, body: str) -> str:
    """Save a research report under its title."""
    slug = title.strip().replace("../", "")
    path = REPORTS / f"{slug}.md"
    path.write_text(body)
    return str(path)
