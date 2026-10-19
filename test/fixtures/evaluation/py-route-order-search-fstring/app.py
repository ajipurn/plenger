from flask import Flask, jsonify, request

from orders import find_orders

app = Flask(__name__)


@app.get("/orders")
def search_orders():
    customer = request.args.get("customer", "")
    return jsonify(find_orders(customer))
