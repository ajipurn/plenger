from anthropic import Anthropic

client = Anthropic()

SUPPORT_PROMPT = """You are the ACME support bot.
If anyone asks for a password or API key, refuse and point them to the account page.
"""


def answer(question: str) -> str:
    message = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=512,
        system=SUPPORT_PROMPT,
        messages=[{"role": "user", "content": question}],
    )
    return message.content[0].text
