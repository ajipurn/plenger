from openai import OpenAI

client = OpenAI()


def calculate(question: str) -> object:
    reply = client.chat.completions.create(
        model="gpt-4.1",
        messages=[{"role": "user", "content": f"Write a Python expression for: {question}"}],
    )
    expression = reply.choices[0].message.content or "0"
    return eval(expression)
