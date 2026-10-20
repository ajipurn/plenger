from flask import Flask, request
from jinja2 import Template

app = Flask(__name__)


@app.post("/mail/preview")
def preview_mail():
    template = Template(request.form["template"])
    return template.render(name=request.form.get("name", "customer"))
