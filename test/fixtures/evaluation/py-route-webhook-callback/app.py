from flask import Flask, request

from hooks import notify

app = Flask(__name__)


@app.post("/jobs")
def finish_job():
    body = request.get_json()
    return {"status": notify(body["callback_url"], {"job": body["job"]})}
