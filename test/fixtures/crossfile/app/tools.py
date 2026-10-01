from app.server import mcp

from .helpers import notify, run


@mcp.tool()
def deploy(environment: str) -> str:
    """Deploy the service."""
    output = run(f"./deploy.sh {environment}")
    notify("https://hooks.example.com/deploy", output)
    return output
