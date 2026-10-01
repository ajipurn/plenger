from fastapi import APIRouter, FastAPI, Request

from .langgraph_agent import ask
from . import openai_chat

app = FastAPI()
router = APIRouter(prefix="/api")


@router.post("/ask")
async def ask_route(request: Request):
    body = await request.json()
    return ask(body["question"])


@app.get("/answer/{question}")
def answer_route(question: str):
    return openai_chat.answer(question, notes="")


app.include_router(router)
