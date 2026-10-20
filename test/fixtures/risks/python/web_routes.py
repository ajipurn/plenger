import os
import sqlite3
import subprocess

from fastapi import Depends, FastAPI
from flask import Flask, request

flask_app = Flask(__name__)
api = FastAPI()
DB = sqlite3.connect("shop.db")
EXPORTS = os.path.realpath("exports")


class Settings:
    log_dir = "/var/log/shop"


def get_settings() -> Settings:
    return Settings()


def export_path(name: str) -> str:
    return os.path.join(EXPORTS, name)


def confined_export_path(name: str) -> str:
    path = os.path.realpath(os.path.join(EXPORTS, name))
    if not path.startswith(EXPORTS + os.sep):
        raise ValueError("outside the exports directory")
    return path


@flask_app.get("/lookup")
def lookup():
    domain = request.args.get("domain", "")
    return subprocess.run(f"nslookup {domain}", shell=True, capture_output=True).stdout


@flask_app.get("/products")
def products():
    term = request.args.get("q", "")
    return DB.execute(f"SELECT * FROM products WHERE name LIKE '%{term}%'").fetchall()


@flask_app.get("/products/safe")
def products_safe():
    term = request.args.get("q", "")
    return DB.execute("SELECT * FROM products WHERE name LIKE ?", (f"%{term}%",)).fetchall()


@api.get("/exports/{name}")
def download_export(name: str):
    with open(export_path(name)) as handle:
        return handle.read()


@api.get("/exports/safe/{name}")
def download_export_safe(name: str):
    with open(confined_export_path(name)) as handle:
        return handle.read()


@api.get("/logs/today")
def todays_log(settings: Settings = Depends(get_settings)):
    with open(os.path.join(settings.log_dir, "today.log")) as handle:
        return handle.read()


@flask_app.get("/proxy")
def proxy():
    import requests

    return requests.get(request.args["url"]).text


@flask_app.post("/calc")
def calc():
    return str(eval(request.form["expression"]))


@flask_app.get("/greet")
def greet():
    from flask import render_template_string

    return render_template_string("Hello " + request.args["name"])


@flask_app.post("/restore")
def restore():
    import pickle

    return str(pickle.loads(request.data))
