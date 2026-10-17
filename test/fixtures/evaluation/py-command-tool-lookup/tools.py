import subprocess

from langchain_core.tools import tool

COMMANDS = {
    "disk": ["df", "-h"],
    "memory": ["free", "-m"],
}


@tool
def system_status(kind: str) -> str:
    """Report disk or memory status."""
    command = COMMANDS.get(kind)
    if command is None:
        return "unknown status"
    return subprocess.run(command, capture_output=True, text=True).stdout
