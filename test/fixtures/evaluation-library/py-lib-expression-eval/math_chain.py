def evaluate_expression(expression):
    """Returns the value of an arithmetic expression, for example one a model wrote."""
    return eval(expression, {"__builtins__": {}}, {})
