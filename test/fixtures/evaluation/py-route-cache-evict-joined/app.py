import os
import subprocess

from flask import Flask, request

app = Flask(__name__)
CACHE_DIR = os.path.realpath("cache")


@app.post("/cache/evict")
def evict():
    name = request.form.get("name", "")
    target = os.path.realpath(os.path.join(CACHE_DIR, name))
    subprocess.run(["rm", "-f", target], check=True)
    return "", 204
