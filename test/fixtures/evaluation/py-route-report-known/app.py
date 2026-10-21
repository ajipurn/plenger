import os

from flask import Flask, request

app = Flask(__name__)
REPORTS_DIR = os.path.realpath("reports")
ALIASES = {"latest": "daily.csv", "summary": "monthly.csv"}
REPORTS = {"daily.csv", "weekly.csv", "monthly.csv"}


def report_path(name):
    if name in ALIASES:
        return os.path.join(REPORTS_DIR, ALIASES[name])
    if name not in REPORTS:
        raise ValueError(f"unknown report: {name}")
    return os.path.join(REPORTS_DIR, name)


@app.get("/reports/download")
def download_report():
    with open(report_path(request.args.get("name", "")), "rb") as handle:
        return handle.read(), 200, {"Content-Type": "text/csv"}
