from agents import Agent
from agents.mcp import MCPServerStdio

git = MCPServerStdio(params={"command": "uvx", "args": ["mcp-server-git"]})
assistant = Agent(name="Assistant", mcp_servers=[git])
