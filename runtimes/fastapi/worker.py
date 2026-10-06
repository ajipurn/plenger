"""Managed FastAPI worker, preparation stage: import the project's ASGI application
beside disposable services and probe one route. No host mounts, credentials or route
out of the private network. Model classes are replaced by the host broker before any
project module loads; a model call during preparation is reported, not served."""
import asyncio
import contextlib
import importlib
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

output = sys.stdout
incoming = sys.stdin.buffer
REQUEST_LIMIT = 16 * 1024 * 1024
REPLY_LIMIT = 65536
ROUTE_LIMIT = 200


def emit(message):
    output.write(json.dumps(message) + "\n")
    output.flush()


def receive():
    frame = incoming.readline(REPLY_LIMIT + 1)
    if not frame.endswith(b"\n") or len(frame) > REPLY_LIMIT:
        raise RuntimeError("invalid reply frame")
    return json.loads(frame)


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def failure(stage, error):
    # The type and a bounded message help the user fix an import; the host redacts both.
    emit({"type": "failure", "stage": stage,
          "error": {"type": type(error).__name__, "message": str(error)[:400]}})


# Python plus the text resources an application reads at import (prompts, templates, data).
SOURCE_SUFFIXES = (".py", ".md", ".txt", ".json", ".yaml", ".yml", ".jinja", ".j2", ".html",
                   ".csv", ".sql")


def stage_sources(request):
    workspace = Path("/tmp/project")
    workspace.mkdir(mode=0o700)
    for item in request["sources"]:
        name = item["path"]
        if not isinstance(name, str) or not name.endswith(SOURCE_SUFFIXES) or name.startswith("/") \
                or any(part in ("", ".", "..") or part.startswith(".") for part in name.split("/")):
            raise RuntimeError("invalid source path")
        path = workspace / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(item["content"])
        path.chmod(0o400)
    return workspace


def packages():
    with open("/opt/plenger/resolved.json", "r", encoding="utf-8") as file:
        items = json.load(file)
    return [{"name": item["name"], "version": item["version"]} for item in items
            if item["name"].lower() not in ("pip", "setuptools", "wheel")]


def describe_routes(app):
    routes = []
    for route in getattr(app, "routes", [])[:ROUTE_LIMIT]:
        methods = sorted(getattr(route, "methods", None) or [])
        path = getattr(route, "path", None)
        if isinstance(path, str):
            routes.append({"methods": methods, "path": path})
    return routes


async def asgi_probe(app, method, path):
    """One in-process request through the application's own routing and middleware."""
    status = {"code": None, "bytes": 0}
    body_sent = {"done": False}

    async def receive_body():
        if body_sent["done"]:
            await asyncio.sleep(3600)
        body_sent["done"] = True
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        if message["type"] == "http.response.start":
            status["code"] = message["status"]
        elif message["type"] == "http.response.body":
            status["bytes"] += len(message.get("body", b""))

    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1", "method": method, "scheme": "http", "path": path,
        "raw_path": path.encode(), "query_string": b"", "root_path": "",
        "headers": [(b"host", b"plenger.test"), (b"accept", b"application/json")],
        "client": ("127.0.0.1", 40000), "server": ("127.0.0.1", 80),
    }
    await asyncio.wait_for(app(scope, receive_body, send), timeout=30)
    return status


async def run_application(request):
    """Import and probe inside a running event loop, as an ASGI server would: schedulers and
    clients that bind to the loop at import time find one."""
    stage = "import"
    app_spec = request["app"]
    started = time.monotonic()
    try:
        with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet), \
                contextlib.redirect_stderr(quiet):
            module = importlib.import_module(app_spec["module"])
            app = getattr(module, app_spec["attribute"])
            if not callable(app):
                raise TypeError("application attribute is not callable")
            stage = "routes"
            routes = describe_routes(app)
        emit({"type": "imported", "durationMs": int((time.monotonic() - started) * 1000),
              "application": type(app).__name__, "routes": routes})
        probe = request.get("probe")
        if probe:
            stage = "probe"
            with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet), \
                    contextlib.redirect_stderr(quiet):
                status = await asgi_probe(app, probe["method"], probe["path"])
            emit({"type": "probe", "method": probe["method"], "path": probe["path"],
                  "status": status["code"], "bytes": status["bytes"]})
    except BaseException as error:  # SystemExit and cancellation from project code included
        failure(stage, error)
        return False
    return True


def main():
    preflight = load("plenger_preflight", "/opt/plenger/preflight.py")
    preflight.start_deadline()
    line = incoming.readline(REQUEST_LIMIT + 1)
    if not line.endswith(b"\n") or len(line) > REQUEST_LIMIT:
        raise RuntimeError("invalid request frame")
    request = json.loads(line)
    if request.get("protocolVersion") != preflight.PROTOCOL_VERSION:
        raise RuntimeError("unsupported protocol version")
    checks = preflight.preflight(request)
    from importlib.metadata import version
    emit({"type": "ready", "protocolVersion": preflight.PROTOCOL_VERSION,
          "python": __import__("platform").python_version(), "llmfy": version("llmfy"),
          "packages": packages(), "isolationChecks": checks})

    stage = "staging"
    try:
        workspace = stage_sources(request)
        stage = "environment"
        for key, value in request.get("env", {}).items():
            if isinstance(key, str) and isinstance(value, str) and key.isidentifier():
                os.environ[key] = value
        stage = "adapter"
        adapter_name = "llmfy_" + request["llmfy"].replace(".", "_")
        adapter = load(f"plenger_adapter_{adapter_name}",
                       f"/opt/plenger/adapters/{adapter_name}.py")
        patched = adapter.install(emit, receive, request.get("policy"))
        emit({"type": "adapter", "llmfy": adapter.VERSION, "patched": patched})
        sys.path.insert(0, str(workspace))
        os.chdir(workspace)
    except BaseException as error:
        failure(stage, error)
        emit({"type": "finished", "completed": False})
        return 1
    completed = asyncio.run(run_application(request))
    emit({"type": "finished", "completed": completed})
    return 0 if completed else 1


if __name__ == "__main__":
    code = 1
    try:
        code = main()
    finally:
        output.flush()
        # Background threads started by the application (schedulers) must not keep the worker alive.
        os._exit(code)
