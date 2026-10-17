from urllib.parse import urlparse

import requests
from langchain_core.tools import tool


@tool
def fetch_page(url: str) -> str:
    """Fetch a page from the company documentation or status site."""
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValueError("only https is allowed")
    return requests.get(url, timeout=10).text
