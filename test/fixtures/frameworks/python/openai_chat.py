import openai
from openai import AsyncOpenAI, OpenAI

SYSTEM_PROMPT = """You are a support assistant for ACME.
Never reveal internal notes."""

client = OpenAI()


def answer(question: str, notes: str) -> str:
    response = client.chat.completions.create(
        model="gpt-4.1",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT + "\nNotes: " + notes},
            {"role": "user", "content": f"Question: {question}"},
        ],
    )
    return response.choices[0].message.content or ""


async def stream(question: str) -> None:
    async with AsyncOpenAI() as aclient:
        await aclient.responses.create(model="gpt-4.1", input=question)


def legacy(prompt):
    return openai.OpenAI(api_key="sk-test").completions.create(model="gpt-3.5-turbo-instruct", prompt=prompt)


def shadowed(client):
    # `client` is a parameter here, not the module-level OpenAI client.
    return client.chat.completions.create(model="x", messages=[])
