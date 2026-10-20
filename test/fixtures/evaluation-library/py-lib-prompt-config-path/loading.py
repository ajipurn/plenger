from pathlib import Path


def load_prompt_from_config(config):
    """Builds a prompt from a configuration, such as one downloaded from a prompt hub."""
    if "template_path" in config:
        template = Path(config["template_path"]).read_text()
    else:
        template = config["template"]
    return {"template": template, "input_variables": config.get("input_variables", [])}
