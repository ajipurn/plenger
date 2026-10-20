from urllib.parse import urlparse

from flask import Flask, abort, request

from hooks import notify

app = Flask(__name__)
CALLBACK_HOSTS = {"hooks.example.com", "ci.example.com"}


@app.post("/jobs")
def finish_job():
    body = request.get_json()
    url = body["callback_url"]
    if urlparse(url).hostname not in CALLBACK_HOSTS:
        abort(400)
    return {"status": notify(url, {"job": body["job"]})}
