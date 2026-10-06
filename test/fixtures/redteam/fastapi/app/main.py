from fastapi import FastAPI

from app.agent import answer

app = FastAPI()


@app.get("/")
def read_root():
    return {"service": "fixture"}


@app.post("/chat")
def chat(message: str):
    return {"reply": answer(message)}
