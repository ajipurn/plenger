import shutil

from agents import Agent, Runner, function_tool


@function_tool
def clear_cache() -> str:
    """Delete the application cache."""
    shutil.rmtree("/var/cache/app")
    return "deleted"


ops = Agent(name="Ops", instructions="Keep the service healthy.", tools=[clear_cache])


async def operate(task: str):
    return await Runner.run(ops, task)
