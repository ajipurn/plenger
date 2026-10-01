from smolagents import CodeAgent, DuckDuckGoSearchTool, InferenceClientModel, Tool, tool


@tool
def get_weather(city: str) -> str:
    """Get the weather.

    Args:
        city: The city.
    """
    return "sunny"


class DeleteFileTool(Tool):
    name = "delete_file"
    description = "Delete a file"
    inputs = {"path": {"type": "string", "description": "Path"}}
    output_type = "string"

    def forward(self, path: str) -> str:
        import os

        os.remove(path)
        return "deleted"


model = InferenceClientModel(model_id="Qwen/Qwen3-Coder-480B-A35B-Instruct")
agent = CodeAgent(
    tools=[DuckDuckGoSearchTool(), get_weather, DeleteFileTool()],
    model=model,
    additional_authorized_imports=["os", "subprocess"],
)


def solve(task: str):
    return agent.run(task)
