from agents import Agent, Runner, WebSearchTool, function_tool, handoff
from agents.mcp import MCPServerStdio


@function_tool
def refund_order(order_id: str, amount: float) -> str:
    """Refund an order."""
    return f"refunded {order_id}"


@function_tool(name_override="lookup_order")
def get_order(order_id: str) -> str:
    """Look up an order."""
    return order_id


billing = Agent(
    name="Billing",
    instructions="You handle refunds. Always confirm the amount.",
    tools=[refund_order, get_order],
)

translator = Agent(name="Translator", instructions="Translate to Spanish.")

files = MCPServerStdio(params={"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv"]})

triage = Agent(
    name="Triage",
    instructions="Route the customer to the right agent.",
    model="gpt-4.1",
    tools=[WebSearchTool(), translator.as_tool(tool_name="translate", tool_description="Translate text")],
    handoffs=[handoff(billing)],
    mcp_servers=[files],
)


def answer(message: str) -> str:
    result = Runner.run_sync(triage, message)
    return result.final_output
