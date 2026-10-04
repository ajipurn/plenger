"""Managed llmfy worker. No host mounts, credentials, network or project installation."""
import asyncio
import contextlib
import functools
import importlib.util
import json
import os
import platform
import sys
from importlib.metadata import version
from pathlib import Path
from unittest.mock import patch

output = sys.stdout
incoming = sys.stdin.buffer


def emit(message):
    output.write(json.dumps(message) + "\n")
    output.flush()


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main():
    line = incoming.readline(16 * 1024 * 1024 + 1)
    if not line.endswith(b"\n") or len(line) > 16 * 1024 * 1024:
        raise RuntimeError("invalid source frame")
    request = json.loads(line)
    qualification = load("plenger_qualification", "/opt/plenger/qualify.py")
    checks = qualification.preflight(request)
    if version("llmfy") != "0.11.0":
        raise RuntimeError("unsupported llmfy version")
    emit({"type": "ready", "python": platform.python_version(), "llmfy": version("llmfy"),
          "isolationChecks": checks})

    # Stage validated snapshot bytes after preflight, with no host filesystem mount.
    workspace = Path("/tmp/project")
    workspace.mkdir(mode=0o700)
    for item in request["sources"]:
        name = item["path"]
        if not isinstance(name, str) or not name.endswith(".py") or name.startswith("/") \
                or any(part in ("", ".", "..") for part in name.split("/")):
            raise RuntimeError("invalid source path")
        path = workspace / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(item["content"])
        path.chmod(0o400)
    canary = Path("/tmp/plenger-canary")
    canary.mkdir(mode=0o700)

    import llmfy
    from llmfy.llmfy_core.llms.base_ai_model import BaseAIModel
    from llmfy.llmfy_core.messages.tool_call import ToolCall
    from llmfy.llmfy_core.model_backend import ModelBackend
    from llmfy.llmfy_core.responses.ai_response import AIResponse
    from llmfy.llmfy_core.service_provider import ServiceProvider

    next_id = 0
    class BrokerModel(BaseAIModel):
        def __init__(self, *args, **kwargs):
            self.backend = ModelBackend.OPENAI_CHAT
            self.provider = ServiceProvider.OPENAI

        def generate(self, messages, tools=None, **kwargs):
            nonlocal next_id
            next_id += 1
            controlled = [{"role": "system", "content": request["policy"]}, *messages]
            emit({"type": "model_request", "id": next_id, "messages": controlled, "tools": tools})
            frame = incoming.readline(65537)
            if not frame.endswith(b"\n") or len(frame) > 65536:
                raise RuntimeError("invalid model frame")
            reply = json.loads(frame)
            if reply.get("type") != "model_response" or reply.get("id") != next_id:
                raise RuntimeError("invalid model correlation")
            value = reply["value"]
            calls = []
            for call in value["toolCalls"]:
                emit({"type": "event", "stage": "model_tool_proposal", "tool": call["name"]})
                calls.append(ToolCall(tool_call_id=call["id"], request_call_id=call["id"],
                                      name=call["name"], arguments=call["arguments"]))
            return AIResponse(content=value["content"], tool_calls=calls or None)

        async def agenerate(self, messages, tools=None, **kwargs):
            return self.generate(messages, tools, **kwargs)

        def generate_stream(self, *args, **kwargs):
            raise RuntimeError("streaming is outside this runtime profile")

        def agenerate_stream(self, *args, **kwargs):
            raise RuntimeError("streaming is outside this runtime profile")

    original_register = llmfy.LLMfy.register_tool
    original_write = Path.write_text

    def observed_write(path, data, *args, **kwargs):
        result = original_write(path, data, *args, **kwargs)
        absolute = os.path.abspath(path)
        for label in ("allowed", "forbidden"):
            if absolute == f"/tmp/plenger-canary/{label}.txt":
                emit({"type": "event", "stage": "canary_state", "boundary": label,
                      "markerPresent": request["marker"] in str(data)})
        return result

    def register(agent, functions):
        def observe(function):
            @functools.wraps(function)
            def wrapper(*args, **kwargs):
                emit({"type": "event", "stage": "tool_handler_entered", "tool": function.__name__})
                result = function(*args, **kwargs)
                emit({"type": "event", "stage": "tool_handler_returned", "tool": function.__name__})
                return result
            return wrapper
        original_register(agent, [observe(function) for function in functions])

    # Execute original handlers and their checks. Observe only private canary state;
    # do not infer business authorization from arbitrary tool calls or response text.
    sys.path.insert(0, str(workspace))
    sys.path.insert(0, str(workspace / Path(request["target"]["path"]).parent))
    os.chdir(workspace)
    completed = False
    with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet), \
            contextlib.redirect_stderr(quiet), patch.object(llmfy, "OpenAIChatModel", BrokerModel), \
            patch.object(Path, "write_text", observed_write), \
            patch.object(llmfy.LLMfy, "register_tool", register):
        try:
            module = load("plenger_project", str(workspace / request["target"]["path"]))
            entry = getattr(module, request["target"]["symbol"])
            result = entry() if request["target"]["kind"] == "factory" else entry(request["input"])
            if asyncio.iscoroutine(result):
                result = asyncio.run(result)
            if request["target"]["kind"] == "factory":
                result = result.invoke_with_tools(request["input"])
            completed = True
        except Exception:
            # Never export application exceptions, stdout, source snippets or secrets.
            pass
    for label in ("allowed", "forbidden"):
        path = canary / f"{label}.txt"
        if path.is_file() and not path.is_symlink():
            with path.open("r", encoding="utf-8", errors="replace") as file:
                observed = file.read(4096)
            emit({"type": "event", "stage": "canary_state", "boundary": label,
                  "markerPresent": request["marker"] in observed})
    emit({"type": "finished", "completed": completed})


if __name__ == "__main__":
    main()
