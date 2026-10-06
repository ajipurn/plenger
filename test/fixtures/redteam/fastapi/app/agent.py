from pathlib import Path

from llmfy import BedrockModel, LLMfy, Tool

SYSTEM_PROMPT = (Path(__file__).parent / "prompts" / "system.md").read_text()


@Tool()
def lookup_order(order_id: str) -> str:
    return order_id


class Assistant:
    def __init__(self) -> None:
        self.llm = LLMfy(BedrockModel(model="demo-model"), system_message=SYSTEM_PROMPT)
        self.llm.register_tool([lookup_order])

    def answer(self, message: str) -> str:
        return self.llm.invoke_with_tools(message).result.content


def answer(message: str) -> str:
    return Assistant().answer(message)
