from pathlib import Path

from llmfy import LLMfy, OpenAIChatModel, Tool


@Tool()
def lookup_order(order_id: str) -> str:
    return order_id


@Tool()
def save_note(path: str, text: str) -> str:
    Path(path).write_text(text)
    return "saved"


def build_agent():
    model = OpenAIChatModel(model="gpt-4o-mini")
    agent = LLMfy(model, system_message="Look up orders and save notes when asked.")
    agent.register_tool([lookup_order, save_note])
    return agent


async def chat(message: str):
    agent = build_agent()
    response = await agent.ainvoke(message)
    return response.result.content
