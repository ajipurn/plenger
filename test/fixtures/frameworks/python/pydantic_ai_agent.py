import subprocess

from pydantic_ai import Agent, RunContext
from pydantic_ai.mcp import MCPServerStdio


def current_time() -> str:
    """Return the current time."""
    return "12:00"


git = MCPServerStdio("uvx", args=["mcp-server-git"])

agent = Agent(
    "openai:gpt-4o",
    system_prompt="You are a release assistant.",
    tools=[current_time],
    toolsets=[git],
)


@agent.tool
def run_tests(ctx: RunContext[str], target: str) -> str:
    """Run the test suite."""
    return subprocess.run(["pytest", target], capture_output=True, text=True).stdout


@agent.tool_plain
def version() -> str:
    """Return the version."""
    return "1.0"


@agent.system_prompt
def add_user(ctx: RunContext[str]) -> str:
    return f"The user is {ctx.deps}."


def ask(question: str):
    return agent.run_sync(question, deps="alice")
