import ast

from langchain_core.tools import tool


@tool
def calculate(expression: str) -> str:
    """Read a number or a list of numbers."""
    return str(ast.literal_eval(expression))
