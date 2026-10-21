from flask import Flask, request

from net import ping

app = Flask(__name__)


@app.get("/health")
def health():
    return {"gateway": ping("10.0.0.1")}


TARGETS = {"db": "10.0.0.5", "cache": "10.0.0.6"}


@app.get("/ping")
def ping_target():
    host = TARGETS[request.args["target"]]
    return {"result": ping(host)}
