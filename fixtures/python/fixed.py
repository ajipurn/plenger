"""SYNTHETIC negative control for WK-PY-001, not a general security guarantee."""

import ast


def calculate(user_input):
    return ast.literal_eval(user_input)
