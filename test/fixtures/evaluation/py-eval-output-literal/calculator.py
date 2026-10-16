import ast

from openai import OpenAI

client = OpenAI()


def extract_numbers(question: str) -> list:
    reply = client.chat.completions.create(
        model="gpt-4.1",
        messages=[{"role": "user", "content": f"List the numbers in: {question}"}],
    )
    value = ast.literal_eval(reply.choices[0].message.content or "[]")
    if not isinstance(value, list) or not all(isinstance(item, (int, float)) for item in value):
        raise ValueError("expected a list of numbers")
    return value
