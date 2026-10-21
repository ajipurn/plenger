import io

import requests
import torch


def load_remote_weights(url):
    response = requests.get(url, timeout=60)
    response.raise_for_status()
    return torch.load(io.BytesIO(response.content), map_location="cpu")
