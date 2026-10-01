from llama_index.core import SimpleDirectoryReader, VectorStoreIndex
from llama_index.core.agent.workflow import FunctionAgent
from llama_index.core.tools import FunctionTool, QueryEngineTool
from llama_index.llms.openai import OpenAI


def multiply(a: float, b: float) -> float:
    """Multiply two numbers."""
    return a * b


documents = SimpleDirectoryReader("data").load_data()
index = VectorStoreIndex.from_documents(documents)
docs_tool = QueryEngineTool.from_defaults(
    query_engine=index.as_query_engine(), name="docs", description="Answer questions about the docs"
)

agent = FunctionAgent(
    tools=[FunctionTool.from_defaults(fn=multiply), docs_tool],
    llm=OpenAI(model="gpt-4o-mini"),
    system_prompt="You answer with the docs and can do arithmetic.",
)


async def ask(question: str):
    return await agent.run(user_msg=question)
