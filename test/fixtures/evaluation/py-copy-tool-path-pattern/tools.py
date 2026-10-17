import re
import shutil
from pathlib import Path

from langchain_core.tools import tool

TEMPLATES = Path("templates").resolve()
WORKDIR = Path("workdir").resolve()


@tool
def copy_template(template: str) -> str:
    """Copy a template into the working directory."""
    name = template.strip()
    if not re.match(r"^[a-zA-Z0-9._/\-]+$", name):
        return "invalid template name"
    destination = WORKDIR / name
    shutil.copytree(TEMPLATES / name, destination)
    return "copied"
