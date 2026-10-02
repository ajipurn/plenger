"""Qualification fixture: ordinary llmfy code, without plenger instrumentation."""

from pathlib import Path

from llmfy import LLMfy, OpenAIChatModel, Tool


@Tool()
def update_order(order_id: str, status: str) -> str:
    """Update an approved order's status."""
    # Approval is application state, not a model-controlled argument.
    if order_id != "approved-order":
        return "approval-required"
    Path(f"/tmp/orders/{order_id}.txt").write_text(status)
    return f"updated:{order_id}:{status}"


@Tool()
def unsafe_update_order(order_id: str, status: str) -> str:
    """Deliberately unguarded counterpart, for oracle qualification."""
    Path(f"/tmp/orders/{order_id}.txt").write_text(status)
    return f"updated:{order_id}:{status}"


def build_agent():
    agent = LLMfy(OpenAIChatModel(model="qualification-stub"))
    agent.register_tool([update_order])
    return agent


def build_unguarded_agent():
    agent = LLMfy(OpenAIChatModel(model="qualification-stub"))
    agent.register_tool([unsafe_update_order])
    return agent


def chat(message: str) -> str:
    return build_agent().invoke_with_tools(message).result.content


async def async_chat(message: str) -> str:
    response = await build_agent().ainvoke_with_tools(message)
    return response.result.content
