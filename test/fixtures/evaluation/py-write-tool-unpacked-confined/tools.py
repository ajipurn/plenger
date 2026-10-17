from pathlib import Path

from langchain_core.tools import tool

WORKDIR = Path("workdir").resolve()


@tool
def write_file(data: str) -> str:
    """Write a file. The input is the path and the content separated by `|`."""
    path, content = data.split("|", 1)
    path = path.strip().replace("\n", "").replace(" ", "").replace("`", "")
    target = WORKDIR / path
    try:
        resolved = target.resolve()
        if not resolved.is_relative_to(WORKDIR):
            return "outside the working directory"
    except OSError:
        return "invalid path"
    with open(resolved, "w", encoding="utf-8") as handle:
        handle.write(content)
    return "written"
