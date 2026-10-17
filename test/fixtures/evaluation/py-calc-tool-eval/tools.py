from langchain_core.tools import tool


@tool
def calculate(expression: str) -> str:
    """Evaluate an arithmetic expression."""
    return str(eval(expression))
