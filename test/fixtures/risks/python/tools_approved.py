import shutil
import subprocess

from agents import Agent, Runner, function_tool


@function_tool(needs_approval=True)
def deploy(service: str) -> str:
    """Deploy a service."""
    return subprocess.run(f"deploy {service}", shell=True, capture_output=True, text=True).stdout


@function_tool
def drop_cache(name: str) -> str:
    """Drop a cache directory."""
    if input(f"Delete cache {name}? [y/N] ") != "y":
        return "cancelled"
    shutil.rmtree(f"/var/cache/app/{name}")
    return "deleted"


ops = Agent(name="Ops", instructions="Operate the service.", tools=[deploy, drop_cache])


async def operate(task: str):
    return await Runner.run(ops, task)
