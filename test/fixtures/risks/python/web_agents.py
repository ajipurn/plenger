from fastapi import FastAPI
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

from .tools_unsafe import calculate, restart, shell

llm = ChatOpenAI(model="gpt-4o")
ops_agent = create_react_agent(llm, tools=[shell, restart])
math_agent = create_react_agent(llm, tools=[calculate], interrupt_before=["tools"])

app = FastAPI()


@app.post("/ops")
async def ops(payload: dict):
    return await ops_agent.ainvoke({"messages": [{"role": "user", "content": payload["task"]}]})


@app.post("/math")
async def math(payload: dict):
    return await math_agent.ainvoke({"messages": [{"role": "user", "content": payload["question"]}]})
