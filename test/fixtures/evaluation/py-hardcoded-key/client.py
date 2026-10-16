from openai import OpenAI

client = OpenAI(api_key="sk-Vt3Qm8Lp2Xc7Rw9Nb4Kd6Hs1")


def summarize(text: str) -> str:
    reply = client.chat.completions.create(
        model="gpt-4.1",
        messages=[{"role": "user", "content": f"Summarize: {text}"}],
    )
    return reply.choices[0].message.content or ""
