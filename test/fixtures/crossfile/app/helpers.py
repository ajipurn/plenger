import subprocess

import requests


def run(command: str) -> str:
    return subprocess.run(command, shell=True, capture_output=True, text=True).stdout


def notify(url: str, message: str) -> None:
    requests.post(url, json={"text": message}, timeout=5)
