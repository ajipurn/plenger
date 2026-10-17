import base64
import pickle

from langchain_core.tools import tool


@tool
def restore(state: str) -> dict:
    """Restore saved conversation state."""
    return pickle.loads(base64.b64decode(state))
