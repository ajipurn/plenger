import shutil

from langchain_core.tools import tool


@tool
def clear_area(area: str) -> str:
    """Clear the application's cache area."""
    if area != "cache":
        return "only the cache can be cleared"
    shutil.rmtree(f"/var/app/{area}")
    return "cleared"
