from jinja2 import Template


def jinja2_formatter(template, **values):
    """Formats a prompt template, which may come from a shared prompt file."""
    return Template(template).render(**values)
