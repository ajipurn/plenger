import subprocess

from agents import Agent
from agents.mcp import MCPServerStdio, MCPServerStreamableHttp
from mcp.server.fastmcp import FastMCP

ops = FastMCP("ops")


@ops.tool()
def run(command: str) -> str:
    """Run a command on the server."""
    return subprocess.run(command, shell=True, capture_output=True, text=True).stdout


filesystem = MCPServerStdio(params={"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem@2025.8.21", "/srv"]})
git = MCPServerStdio(params={"command": "uvx", "args": ["mcp-server-git"]})
fetcher = MCPServerStdio(params={"command": "docker", "args": ["run", "-i", "--rm", "mcp/fetch"]})
remote = MCPServerStreamableHttp(params={"url": "http://tools.acme.example/mcp"})
local = MCPServerStreamableHttp(params={"url": "http://localhost:8000/mcp"})
assistant = Agent(name="Assistant", mcp_servers=[filesystem, git, fetcher, remote, local])

if __name__ == "__main__":
    ops.run(transport="streamable-http")
