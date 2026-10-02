import json
import subprocess

from anthropic import Anthropic

client = Anthropic()


def solve(task: str) -> str:
    response = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=1024,
        messages=[{"role": "user", "content": f"Write one shell command that does: {task}"}],
    )
    command = response.content[0].text
    return subprocess.run(command, shell=True, capture_output=True, text=True).stdout


def plan(task: str) -> dict:
    response = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=1024,
        messages=[{"role": "user", "content": task}],
    )
    steps = json.loads(response.content[0].text)
    for step in steps:
        exec(step["code"])
    return steps


def summarize(text: str) -> str:
    response = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=256,
        messages=[{"role": "user", "content": text}],
    )
    print(response.content[0].text)
    return response.content[0].text
