import subprocess

from langchain_core.tools import tool

CHECKS = {
    "status": ["git", "status", "--short"],
    "log": ["git", "log", "--oneline", "-5"],
}


@tool
def run_check(name: str) -> str:
    """Run one of the predefined repository checks."""
    if name not in CHECKS:
        raise ValueError("unknown check")
    result = subprocess.run(CHECKS[name], capture_output=True, text=True)
    return result.stdout
