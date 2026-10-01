from fastapi import FastAPI
from openai import OpenAI

from app.tools import run_shell

app = FastAPI()
client = OpenAI()


@app.post("/chat")
def chat(message: str) -> str:
    response = client.chat.completions.create(
        model="gpt-4.1",
        messages=[{"role": "user", "content": message}],
    )
    return response.choices[0].message.content or ""
