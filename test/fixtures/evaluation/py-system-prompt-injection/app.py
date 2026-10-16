from fastapi import FastAPI
from openai import OpenAI
from pydantic import BaseModel

app = FastAPI()
client = OpenAI()


class Ask(BaseModel):
    persona: str
    question: str


@app.post("/ask")
def ask(body: Ask) -> str:
    reply = client.chat.completions.create(
        model="gpt-4.1",
        messages=[
            {"role": "system", "content": f"You are {body.persona}. Follow the company policy."},
            {"role": "user", "content": body.question},
        ],
    )
    return reply.choices[0].message.content or ""
