from urllib.parse import urlparse

import requests
from langchain_core.tools import tool

ALLOWED_HOSTS = ("docs.example.com", "status.example.com")


@tool
def fetch_page(url: str) -> str:
    """Fetch a page from the company documentation or status site."""
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
        raise ValueError("host not allowed")
    return requests.get(url, timeout=10, allow_redirects=False).text
