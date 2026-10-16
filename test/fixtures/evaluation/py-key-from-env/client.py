import os

from openai import OpenAI

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])


def summarize(text: str) -> str:
    reply = client.chat.completions.create(
        model="gpt-4.1",
        messages=[{"role": "user", "content": f"Summarize: {text}"}],
    )
    return reply.choices[0].message.content or ""
