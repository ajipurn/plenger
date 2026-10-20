import os

from flask import Flask, request

app = Flask(__name__)
REPORTS_DIR = os.path.realpath("reports")
REPORTS = {"daily.csv", "weekly.csv", "monthly.csv"}


@app.get("/reports/download")
def download_report():
    name = request.args.get("name", "")
    if name not in REPORTS:
        app.logger.warning("unknown report %s", name)
    with open(os.path.join(REPORTS_DIR, name), "rb") as handle:
        return handle.read(), 200, {"Content-Type": "text/csv"}
