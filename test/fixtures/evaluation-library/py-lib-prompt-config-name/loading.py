import re
from pathlib import Path

TEMPLATES = Path(__file__).parent / "templates"


def load_prompt_from_config(config):
    """Builds a prompt from a configuration, such as one downloaded from a prompt hub."""
    if "template_name" in config:
        name = config["template_name"]
        if not re.match(r"^[A-Za-z0-9_-]+$", name):
            raise ValueError(f"invalid template name: {name}")
        template = (TEMPLATES / f"{name}.txt").read_text()
    else:
        template = config["template"]
    return {"template": template, "input_variables": config.get("input_variables", [])}
