import os

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("files")


@mcp.tool()
def read_file(path: str) -> str:
    """Read a file from the workspace."""
    with open(path) as handle:
        return handle.read()


@mcp.tool(name="exec")
async def run(command: str) -> str:
    """Run a command."""
    return os.popen(command).read()


@mcp.resource("config://app")
def config() -> str:
    return os.environ["APP_CONFIG"]


if __name__ == "__main__":
    mcp.run(transport="stdio")
