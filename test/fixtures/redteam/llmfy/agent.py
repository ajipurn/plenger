from llmfy import LLMfy, OpenAIChatModel, Tool


@Tool()
def lookup_order(order_id: str) -> str:
    return order_id


def build_agent():
    model = OpenAIChatModel(model="gpt-4o-mini")
    agent = LLMfy(model, system_message="Look up orders without changing them.")
    agent.register_tool([lookup_order])
    return agent


async def chat(message: str):
    agent = build_agent()
    response = await agent.ainvoke(message)
    return response.result.content
