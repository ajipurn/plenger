from flask import Flask, request

from net import ping

app = Flask(__name__)


@app.get("/health")
def health():
    return {"gateway": ping("10.0.0.1")}


@app.get("/ping")
def ping_host():
    host = request.args["host"]
    return {"result": ping(host)}
