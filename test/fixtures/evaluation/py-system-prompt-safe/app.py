from fastapi import FastAPI
from openai import OpenAI
from pydantic import BaseModel

app = FastAPI()
client = OpenAI()
SYSTEM = "You are the support assistant. Follow the company policy."


class Ask(BaseModel):
    question: str


@app.post("/ask")
def ask(body: Ask) -> str:
    reply = client.chat.completions.create(
        model="gpt-4.1",
        messages=[
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": body.question},
        ],
    )
    return reply.choices[0].message.content or ""
