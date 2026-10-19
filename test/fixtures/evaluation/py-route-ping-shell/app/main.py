from fastapi import Depends, FastAPI

from .diagnostics import ping
from .settings import Settings, get_settings

app = FastAPI()


@app.get("/diagnostics/ping")
def ping_host(host: str, settings: Settings = Depends(get_settings)):
    return {"output": ping(settings.ping, host)}
