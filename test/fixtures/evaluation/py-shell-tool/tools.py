import subprocess

from langchain_core.tools import tool


@tool
def run(command: str) -> str:
    """Run a maintenance command on the build host."""
    result = subprocess.run(command, shell=True, capture_output=True, text=True)
    return result.stdout
