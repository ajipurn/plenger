from pathlib import Path

from langchain_core.tools import tool

REPORTS = {"daily", "weekly", "monthly"}


@tool
def save_report(name: str, body: str) -> str:
    """Save one of the standard reports."""
    if name not in REPORTS:
        print(f"unexpected report name: {name}")
    Path(f"/srv/reports/{name}.md").write_text(body)
    return "saved"
