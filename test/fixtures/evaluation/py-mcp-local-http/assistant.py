from agents import Agent
from agents.mcp import MCPServerStreamableHttp

local = MCPServerStreamableHttp(params={"url": "http://localhost:8000/mcp"})
assistant = Agent(name="Assistant", mcp_servers=[local])
