import base64
import json

from langchain_core.tools import tool


@tool
def restore(state: str) -> dict:
    """Restore saved conversation state."""
    return json.loads(base64.b64decode(state))
