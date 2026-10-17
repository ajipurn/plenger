from fastapi import FastAPI

from .storage import report_path

app = FastAPI()


@app.get("/reports/{name}")
def download_report(name: str):
    with open(report_path(name), encoding="utf-8") as handle:
        return {"content": handle.read()}
