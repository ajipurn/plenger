from langchain_core.tools import BaseTool, tool
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent


@tool
def search_docs(query: str) -> str:
    """Search the internal documentation."""
    return query


@tool("delete_file", return_direct=True)
def delete_file(path: str) -> str:
    """Delete a file from disk."""
    import os

    os.remove(path)
    return "deleted"


class FetchTool(BaseTool):
    name: str = "fetch"
    description: str = "Fetch a URL"

    def _run(self, url: str) -> str:
        import requests

        return requests.get(url, timeout=10).text


llm = ChatOpenAI(model="gpt-4o", temperature=0)
agent = create_react_agent(llm, tools=[search_docs, delete_file, FetchTool()])


def ask(question: str):
    return agent.invoke({"messages": [("user", question)]})


bound = ChatOpenAI(model="gpt-4o").bind_tools([search_docs]).invoke("hi")
