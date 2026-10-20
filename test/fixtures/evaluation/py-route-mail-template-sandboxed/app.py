from flask import Flask, request
from jinja2.sandbox import SandboxedEnvironment

app = Flask(__name__)
SANDBOX = SandboxedEnvironment()


@app.post("/mail/preview")
def preview_mail():
    template = SANDBOX.from_string(request.form["template"])
    return template.render(name=request.form.get("name", "customer"))
