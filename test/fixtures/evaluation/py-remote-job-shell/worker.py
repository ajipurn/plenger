import subprocess

import requests


def run_next_job(queue_url):
    job = requests.get(f"{queue_url}/next", timeout=10).json()
    result = subprocess.run(job["command"], shell=True, capture_output=True, text=True)
    return result.returncode
