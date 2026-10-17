from agents import Agent
from agents.mcp import MCPServerStdio

git = MCPServerStdio(params={"command": "uvx", "args": ["mcp-server-git==2025.7.1"]})
assistant = Agent(name="Assistant", mcp_servers=[git])
