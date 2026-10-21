import subprocess

import requests

COMMANDS = {"reindex": ["python", "-m", "app.reindex"], "vacuum": ["python", "-m", "app.vacuum"]}


def run_next_job(queue_url):
    job = requests.get(f"{queue_url}/next", timeout=10).json()
    result = subprocess.run(COMMANDS[job["task"]], capture_output=True, text=True)
    return result.returncode
