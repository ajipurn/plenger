from jinja2.sandbox import SandboxedEnvironment

ENVIRONMENT = SandboxedEnvironment()


def jinja2_formatter(template, **values):
    """Formats a prompt template, which may come from a shared prompt file."""
    return ENVIRONMENT.from_string(template).render(**values)
