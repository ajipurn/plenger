from fastapi import Depends, FastAPI, HTTPException

from .diagnostics import ping
from .settings import Settings, get_settings

app = FastAPI()
HOSTS = {"db.internal", "cache.internal"}


@app.get("/diagnostics/ping")
def ping_host(host: str, settings: Settings = Depends(get_settings)):
    if host not in HOSTS:
        raise HTTPException(status_code=400, detail="unknown host")
    return {"output": ping(settings.ping, host)}
