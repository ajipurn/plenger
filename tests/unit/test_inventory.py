from plenger.domain.parser import ParserResult
from plenger.graph.worker import analyze


def test_explicit_agent_and_model_inventory_is_not_inferred_from_plain_names():
    source = """from agents import Agent, Runner, function_tool
from openai import OpenAI

@function_tool
def lookup(value):
    return value

agent = Agent(name="support", tools=[lookup])
client = OpenAI()
result = client.responses.create(model="gpt-test", input="hello")
Runner.run_sync(agent, "hello")
"""
    result = analyze({"agent.py": source}, "project")
    ParserResult.model_validate(result)
    kinds = [node["kind"] for node in result["nodes"]]
    labels = [node["label"] for node in result["nodes"]]
    assert "agent" in kinds
    assert "tool" in kinds
    assert "llm_call" in kinds
    assert "agent support" in labels
    assert "lookup" in labels
    assert any(edge["kind"] == "invokes_tool" for edge in result["edges"])


def test_unimported_agent_like_calls_are_not_claimed_as_inventory():
    result = analyze(
        {"plain.py": 'agent = Agent(name="not-supported")\nclient.responses.create(input="x")'},
        "project",
    )
    assert not [node for node in result["nodes"] if node["kind"] in {"agent", "llm_call"}]
