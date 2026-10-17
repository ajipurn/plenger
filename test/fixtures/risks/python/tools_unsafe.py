import os
import pickle
import shlex
import sqlite3
import subprocess
from pathlib import Path

import requests
from langchain_core.tools import tool

WEATHER_API = "https://api.weather.example"
DB = sqlite3.connect("app.db")


@tool
def shell(command: str) -> str:
    """Run a shell command."""
    return subprocess.run(command, shell=True, capture_output=True, text=True).stdout


@tool
def run_program(argv: list[str]) -> str:
    """Run a program with arguments."""
    return subprocess.run(argv, capture_output=True, text=True).stdout


@tool
def git_log(ref: str) -> str:
    """Show the history of a git ref."""
    return subprocess.run(["git", "log", "--oneline", ref], capture_output=True, text=True).stdout


@tool
def greet(name: str) -> str:
    """Greet someone from the shell."""
    return subprocess.check_output(f"echo Hello {shlex.quote(name)}", shell=True).decode()


@tool
def calculate(expression: str) -> str:
    """Evaluate an arithmetic expression."""
    return str(eval(expression))


@tool
def save_note(name: str, text: str) -> str:
    """Save a note."""
    Path(f"notes/{name}.md").write_text(text)
    return "saved"


@tool
def read_note(name: str) -> str:
    """Read a note."""
    path = os.path.realpath(os.path.join("notes", name))
    if not path.startswith(os.path.realpath("notes") + os.sep):
        raise ValueError("outside the notes directory")
    with open(path) as handle:
        return handle.read()


@tool
def fetch_page(url: str) -> str:
    """Fetch a web page."""
    return requests.get(url, timeout=10).text


@tool
def weather(city: str) -> str:
    """Current weather for a city."""
    return requests.get(f"{WEATHER_API}/v1/current?city={city}", timeout=10).text


@tool
def run_sql(sql: str) -> list:
    """Run a SQL query."""
    return DB.execute(sql).fetchall()


@tool
def orders_for(customer: str) -> list:
    """Orders of a customer."""
    return DB.execute(f"SELECT * FROM orders WHERE customer = '{customer}'").fetchall()


@tool
def find_user(name: str) -> list:
    """Find a user by name."""
    return DB.execute("SELECT * FROM users WHERE name = ?", (name,)).fetchall()


@tool
def restore(blob: bytes) -> dict:
    """Restore saved state."""
    return pickle.loads(blob)


@tool
def restart() -> str:
    """Restart the application service."""
    return subprocess.run(["systemctl", "restart", "app"], capture_output=True, text=True).stdout
