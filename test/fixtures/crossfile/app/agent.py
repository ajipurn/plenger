from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

from .lc_tools import restart
from .prompts import SYSTEM


def build_agent():
    llm = ChatOpenAI(model="gpt-4o")
    return create_react_agent(llm, tools=[restart], prompt=SYSTEM)
