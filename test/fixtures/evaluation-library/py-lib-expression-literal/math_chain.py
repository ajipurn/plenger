import ast


def evaluate_expression(expression):
    """Returns the value of a literal expression, for example one a model wrote."""
    return ast.literal_eval(expression)
