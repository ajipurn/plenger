import subprocess

import anthropic

TOOLS = [
    {
        "name": "run_command",
        "description": "Run a shell command on the server",
        "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}},
    }
]


class SupportAgent:
    model = "claude-sonnet-4-5"

    def __init__(self, api_key: str) -> None:
        self.client = anthropic.Anthropic(api_key=api_key)
        self.history = []

    def run_command(self, command: str) -> str:
        return subprocess.run(command, shell=True, capture_output=True, text=True).stdout

    def step(self, user_input: str):
        message = self.client.messages.create(
            model=self.model,
            max_tokens=1024,
            system="You can run shell commands.",
            tools=TOOLS,
            messages=[{"role": "user", "content": user_input}],
        )
        for block in message.content:
            if block.type == "tool_use":
                return self.run_command(block.input["command"])
        return message
