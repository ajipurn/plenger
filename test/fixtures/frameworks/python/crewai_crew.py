from crewai import LLM, Agent, Crew, Task
from crewai.tools import tool
from crewai_tools import FileReadTool, SerperDevTool


@tool("Send email")
def send_email(to: str, body: str) -> str:
    """Send an email to a customer."""
    return "sent"


llm = LLM(model="anthropic/claude-sonnet-4-5", temperature=0.2)

researcher = Agent(
    role="Researcher",
    goal="Find facts about {topic}",
    backstory="You are a careful analyst.",
    tools=[SerperDevTool(), FileReadTool()],
    llm=llm,
)
writer = Agent(
    role="Writer",
    goal="Write a summary and email it",
    backstory="You write clearly.",
    tools=[send_email],
    llm=llm,
    allow_code_execution=True,
)

research = Task(description="Research {topic} and list sources.", expected_output="A list", agent=researcher)
summary = Task(description="Summarise the research for {customer}.", expected_output="An email", agent=writer)

crew = Crew(agents=[researcher, writer], tasks=[research, summary])


def run(topic: str, customer: str):
    return crew.kickoff(inputs={"topic": topic, "customer": customer})
