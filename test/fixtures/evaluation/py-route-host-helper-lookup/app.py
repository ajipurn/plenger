import subprocess

from flask import Flask

from params import requested_host

app = Flask(__name__)


@app.get("/trace")
def trace():
    host = requested_host()
    return subprocess.run(f"traceroute -m 5 {host}", shell=True, capture_output=True).stdout
