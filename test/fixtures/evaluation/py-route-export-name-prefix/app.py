import os
import re

from fastapi import FastAPI

app = FastAPI()
EXPORTS = os.path.realpath("exports")


@app.get("/exports")
def read_export(name: str):
    if not re.match(r"[A-Za-z0-9_-]+", name):
        return {"error": "invalid export name"}
    with open(os.path.join(EXPORTS, name)) as handle:
        return {"rows": handle.read().splitlines()}
