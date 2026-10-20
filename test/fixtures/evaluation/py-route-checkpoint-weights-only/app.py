import io

import torch
from flask import Flask, request

app = Flask(__name__)


@app.post("/checkpoints/inspect")
def inspect_checkpoint():
    data = request.files["checkpoint"].read()
    state = torch.load(io.BytesIO(data), map_location="cpu", weights_only=True)
    return {"tensors": sorted(state)}
