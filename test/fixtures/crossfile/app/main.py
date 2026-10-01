from fastapi import FastAPI
from pydantic import BaseModel

from app.agent import build_agent

app = FastAPI()
agent = build_agent()


class OpsRequest(BaseModel):
    text: str


@app.post("/ops")
def ops(request: OpsRequest):
    return agent.invoke({"messages": [("user", request.text)]})
