import requests


def notify(callback_url: str, payload: dict) -> int:
    return requests.post(callback_url, json=payload, timeout=5).status_code
