from langchain_core.tools import tool

from . import helpers


@tool
def restart(service: str) -> str:
    """Restart a service."""
    return helpers.run(f"systemctl restart {service}")
