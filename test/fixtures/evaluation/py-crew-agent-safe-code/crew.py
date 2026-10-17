from crewai import Agent

analyst = Agent(
    role="Analyst",
    goal="Analyse sales data",
    backstory="Writes Python to analyse data.",
    allow_code_execution=True,
    code_execution_mode="safe",
)
