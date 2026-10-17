from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.conditions import MaxMessageTermination
from autogen_agentchat.teams import RoundRobinGroupChat
from autogen_ext.models.openai import OpenAIChatCompletionClient

client = OpenAIChatCompletionClient(model="gpt-4o")
planner = AssistantAgent("planner", model_client=client)
critic = AssistantAgent("critic", model_client=client)

team = RoundRobinGroupChat([planner, critic], termination_condition=MaxMessageTermination(10))
