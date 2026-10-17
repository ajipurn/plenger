from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.teams import RoundRobinGroupChat
from autogen_ext.models.openai import OpenAIChatCompletionClient

client = OpenAIChatCompletionClient(model="gpt-4o")
planner = AssistantAgent("planner", model_client=client)
critic = AssistantAgent("critic", model_client=client)

team = RoundRobinGroupChat([planner, critic])
