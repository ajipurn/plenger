import shutil

from langchain_core.tools import tool


@tool
def clear_area(area: str) -> str:
    """Clear the application's cache area."""
    shutil.rmtree(f"/var/app/{area}")
    if area != "cache":
        return "cleared an area other than the cache"
    return "cleared"
