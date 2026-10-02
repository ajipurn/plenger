from autogen_agentchat.agents import AssistantAgent, CodeExecutorAgent
from autogen_agentchat.teams import RoundRobinGroupChat
from autogen_ext.code_executors.docker import DockerCommandLineCodeExecutor
from autogen_ext.code_executors.local import LocalCommandLineCodeExecutor
from autogen_ext.models.openai import OpenAIChatCompletionClient
from crewai import Agent as CrewAgent
from langchain_experimental.tools import PythonREPLTool
from langgraph.prebuilt import create_react_agent
from smolagents import CodeAgent, InferenceClientModel

model = InferenceClientModel()
local_coder = CodeAgent(tools=[], model=model, additional_authorized_imports=["*"])
docker_coder = CodeAgent(tools=[], model=model, executor_type="docker")

analyst = CrewAgent(
    role="Analyst",
    goal="Analyse data",
    backstory="Writes Python to analyse data.",
    allow_code_execution=True,
    code_execution_mode="unsafe",
)

client = OpenAIChatCompletionClient(model="gpt-4o")
local_runner = CodeExecutorAgent("local_runner", code_executor=LocalCommandLineCodeExecutor(work_dir="out"))
docker_runner = CodeExecutorAgent("docker_runner", code_executor=DockerCommandLineCodeExecutor(work_dir="out"))
writer = AssistantAgent("writer", model_client=client)
team = RoundRobinGroupChat([writer, docker_runner])

repl_agent = create_react_agent("openai:gpt-4o", tools=[PythonREPLTool()])
