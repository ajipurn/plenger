from typing import Annotated, TypedDict

from llmfy import (
    END,
    START,
    FlowEngine,
    InMemoryCheckpointer,
    LLMfy,
    Message,
    OpenAIChatConfig,
    OpenAIChatModel,
    Role,
    Tool,
    ToolRegistry,
    tools_node,
)

SYSTEM_PROMPT = """Answer using only this context:
{{info}}"""


class AppState(TypedDict):
    messages: Annotated[list[Message], lambda old, new: (old or []) + new]


@Tool()
def get_order(order_id: str) -> str:
    """Look up an order."""
    return order_id


def answer_with_context(question: str, info: str) -> str:
    model = OpenAIChatModel(model="gpt-4o-mini", config=OpenAIChatConfig(temperature=0.2))
    framework = LLMfy(model, system_message=SYSTEM_PROMPT, input_variables=["info"])
    response = framework.invoke(question, info=info)
    return response.result.content


def build_agent() -> FlowEngine:
    model = OpenAIChatModel(model="gpt-4o-mini", config=OpenAIChatConfig(temperature=0.7))
    llm = LLMfy(model, system_message="You are a helpful assistant.")

    @Tool()
    def cancel_order(order_id: str) -> str:
        """Cancel an order."""
        return order_id

    tools = [get_order, cancel_order]
    llm.register_tool(tools)
    registry = ToolRegistry(tools, model)

    def main_orchestrator(state: AppState) -> dict:
        response = llm.chat(state["messages"])
        return {"messages": [response.messages[-1]]}

    def tools_executor(state: AppState) -> dict:
        return {"messages": tools_node(messages=state["messages"], registry=registry)}

    flow = FlowEngine(AppState, checkpointer=InMemoryCheckpointer())
    flow.add_node("main", main_orchestrator)
    flow.add_node("tools", tools_executor)
    flow.add_edge(START, "main")
    flow.add_edge("tools", "main")
    flow.add_conditional_edges("main", lambda state: "tools" if state["messages"][-1].tool_calls else END, ["tools", END])
    return flow.build()


async def chat(user_input: str):
    agent = build_agent()
    return await agent.invoke(
        apply_state={"messages": [Message(role=Role.USER, content=user_input)]},
        session_id="demo",
    )
