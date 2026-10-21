import os

from flask import Flask, request, send_from_directory

app = Flask(__name__)
EXPORTS_DIR = os.path.realpath("exports")


@app.get("/exports/download")
def download_export():
    name = request.args.get("name", "")
    return send_from_directory(EXPORTS_DIR, name, as_attachment=True)
