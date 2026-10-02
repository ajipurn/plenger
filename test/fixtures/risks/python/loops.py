from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.conditions import MaxMessageTermination
from autogen_agentchat.teams import RoundRobinGroupChat, SelectorGroupChat
from autogen_ext.models.openai import OpenAIChatCompletionClient
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

client = OpenAIChatCompletionClient(model="gpt-4o")
planner = AssistantAgent("planner", model_client=client)
critic = AssistantAgent("critic", model_client=client)

endless = RoundRobinGroupChat([planner, critic])
bounded = SelectorGroupChat([planner, critic], model_client=client, termination_condition=MaxMessageTermination(10))

researcher = create_react_agent(ChatOpenAI(model="gpt-4o"), tools=[])


def research(topic: str):
    return researcher.invoke({"messages": [("user", topic)]}, config={"recursion_limit": 10_000})
