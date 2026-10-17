from agents import Agent
from agents.mcp import MCPServerStreamableHttp

remote = MCPServerStreamableHttp(params={"url": "http://tools.acme.example/mcp"})
assistant = Agent(name="Assistant", mcp_servers=[remote])
