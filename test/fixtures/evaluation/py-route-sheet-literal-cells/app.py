import ast

from flask import Flask, jsonify, request

app = Flask(__name__)


@app.post("/sheets/evaluate")
def evaluate_sheet():
    rows = request.get_json()["rows"]
    return jsonify([[ast.literal_eval(cell) for cell in row] for row in rows])
