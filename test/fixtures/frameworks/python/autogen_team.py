from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.teams import RoundRobinGroupChat
from autogen_ext.models.openai import OpenAIChatCompletionClient


async def search_web(query: str) -> str:
    """Search the web."""
    return query


client = OpenAIChatCompletionClient(model="gpt-4o")
researcher = AssistantAgent("researcher", model_client=client, tools=[search_web], system_message="Research the topic.")
critic = AssistantAgent("critic", model_client=client, system_message="Criticise the research.")
team = RoundRobinGroupChat([researcher, critic], max_turns=4)


async def main(task: str):
    return await team.run(task=task)
