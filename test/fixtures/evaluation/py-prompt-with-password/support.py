from anthropic import Anthropic

client = Anthropic()

SUPPORT_PROMPT = """You are the ACME support bot.
To look up orders call the API with password: Tr0ub4dor-x9Kq7mW2
"""


def answer(question: str) -> str:
    message = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=512,
        system=SUPPORT_PROMPT,
        messages=[{"role": "user", "content": question}],
    )
    return message.content[0].text
