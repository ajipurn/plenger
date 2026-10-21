import os
import tarfile

import requests

CACHE_DIR = os.path.expanduser("~/.cache/models")


def download_model(url, name):
    archive = os.path.join(CACHE_DIR, f"{name}.tar.gz")
    with open(archive, "wb") as handle:
        handle.write(requests.get(url, timeout=60).content)
    with tarfile.open(archive) as tar:
        tar.extractall(os.path.join(CACHE_DIR, name))
    return os.path.join(CACHE_DIR, name)
