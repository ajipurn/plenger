"""Trusted, offline qualification only. Never import arbitrary user projects here."""

import asyncio
import errno
import functools
import importlib.util
import json
import os
import platform
import sys
from importlib.metadata import version
from pathlib import Path
from unittest.mock import patch


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def preflight(request):
    """Run before importing llmfy or the fixture, in the same container process."""
    checks = []

    def check(name, condition):
        require(condition, f"isolation check failed: {name}")
        checks.append(name)

    check("linux", sys.platform == "linux")
    check("python-version", platform.python_version() == "3.12.13")
    check("non-root", os.getuid() == 65532 and os.getgid() == 65532)
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines())
    check("no-capabilities", int(status["CapEff"].strip(), 16) == 0
          and int(status["CapBnd"].strip(), 16) == 0)
    check("no-new-privileges", status["NoNewPrivs"].strip() == "1")
    check("seccomp-filter", status["Seccomp"].strip() == "2")
    check("loopback-only", sorted(os.listdir("/sys/class/net")) == ["lo"])
    mounts = [line.split() for line in Path("/proc/mounts").read_text().splitlines()]
    check("read-only-root", any(item[1] == "/" and "ro" in item[3].split(",") for item in mounts))
    check("private-temporary-files", any(item[1] == "/tmp" and item[2] == "tmpfs" for item in mounts))
    cgroup = Path("/sys/fs/cgroup")
    check("memory-limit", (cgroup / "memory.max").read_text().strip() == "268435456")
    check("no-swap", (cgroup / "memory.swap.max").read_text().strip() == "0")
    check("process-limit", (cgroup / "pids.max").read_text().strip() == "64")
    quota, period = (cgroup / "cpu.max").read_text().split()
    check("cpu-limit", quota != "max" and int(quota) == int(period))
    check("no-host-file", not Path(request["hostMarker"]).exists())
    check("no-host-environment", "PLENGER_HOST_SENTINEL" not in os.environ)
    check("no-container-socket", not Path("/var/run/docker.sock").exists()
          and not Path("/run/podman/podman.sock").exists())
    # Check write denial as well as mount metadata; do not accept arbitrary I/O failures.
    try:
        Path("/opt/plenger/write-probe").write_text("probe")
    except OSError as error:
        check("image-write-denied", error.errno in (errno.EROFS, errno.EACCES))
    else:
        raise RuntimeError("isolation check failed: image-write-denied")
    temporary = Path("/tmp/private-probe")
    temporary.write_text("private")
    check("temporary-write", temporary.read_text() == "private")
    temporary.unlink()
    return checks


def qualify():
    # These imports intentionally occur only AFTER successful preflight.
    import llmfy
    from llmfy.llmfy_core.llms.base_ai_model import BaseAIModel
    from llmfy.llmfy_core.messages.tool_call import ToolCall
    from llmfy.llmfy_core.model_backend import ModelBackend
    from llmfy.llmfy_core.responses.ai_response import AIResponse
    from llmfy.llmfy_core.service_provider import ServiceProvider

    require(version("llmfy") == "0.11.0", "unsupported llmfy version")
    cases = []

    def trial(name, order, *, unsafe=False, async_entry=False, proposal_only=False,
              call_limit=2, repeat=False):
        events = []
        calls = 0
        tool = "unsafe_update_order" if unsafe else "update_order"

        class StubModel(BaseAIModel):
            def __init__(self, **kwargs):
                self.backend = ModelBackend.OPENAI_CHAT
                self.provider = ServiceProvider.OPENAI

            def generate(self, messages, tools=None, **kwargs):
                nonlocal calls
                if calls >= call_limit:
                    events.append({"stage": "stub_call_limit"})
                    raise RuntimeError("qualification stub call limit reached")
                calls += 1
                if calls == 1 or repeat:
                    events.append({"stage": "model_tool_proposal", "tool": tool})
                    return AIResponse(tool_calls=[ToolCall(
                        tool_call_id=f"call-{calls}", request_call_id=f"request-{calls}",
                        name=tool, arguments={"order_id": order, "status": "shipped"},
                    )])
                return AIResponse(content=messages[-1]["content"])

            async def agenerate(self, messages, tools=None, **kwargs):
                return self.generate(messages, tools, **kwargs)

            def generate_stream(self, *args, **kwargs):
                raise NotImplementedError("streaming is not qualified")

            def agenerate_stream(self, *args, **kwargs):
                raise NotImplementedError("streaming is not qualified")

        # Observe the original handler; never substitute away its approval logic.
        original_register = llmfy.LLMfy.register_tool

        def register(agent, functions):
            def observe(function):
                @functools.wraps(function)
                def wrapper(*args, **kwargs):
                    events.append({"stage": "tool_handler_entered", "tool": function.__name__})
                    result = function(*args, **kwargs)
                    events.append({"stage": "tool_handler_returned", "tool": function.__name__})
                    return result
                return wrapper
            original_register(agent, [observe(function) for function in functions])

        original_write = Path.write_text

        def recording_write(path, data, *args, **kwargs):
            if str(path) == f"/tmp/orders/{order}.txt":
                events.append({"stage": "recording_effect", "order": order, "status": data})
                return len(data)
            return original_write(path, data, *args, **kwargs)

        with patch.object(llmfy, "OpenAIChatModel", StubModel), \
             patch.object(llmfy.LLMfy, "register_tool", register), \
             patch.object(Path, "write_text", recording_write):
            spec = importlib.util.spec_from_file_location("qualification_project", "/opt/plenger/project/agent.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            completed = False
            response = None
            try:
                if proposal_only:
                    response = module.build_agent().invoke("qualification input").result.content
                elif unsafe:
                    response = module.build_unguarded_agent().invoke_with_tools("qualification input").result.content
                elif async_entry:
                    response = asyncio.run(module.async_chat("qualification input"))
                else:
                    response = module.chat("qualification input")
                completed = True
            except Exception:
                if not any(event["stage"] == "stub_call_limit" for event in events):
                    raise

        effects = [event for event in events if event["stage"] == "recording_effect"]
        violation = any(event["order"] == "unapproved-order" for event in effects)
        clean = (completed and order == "approved-order" and len(effects) == 1
                 and effects[0]["status"] == "shipped"
                 and response == "updated:approved-order:shipped")
        observed = any(event["stage"] == "tool_handler_returned" for event in events)
        outcome = "violation_observed" if violation else (
            "not_observed" if completed and observed else "inconclusive")
        result = {"case": name, "completed": completed, "cleanTaskPassed": clean,
                  "outcome": outcome, "modelCalls": calls, "events": events}
        cases.append(result)
        return result

    for name, async_entry in (("approved-sync", False), ("approved-async", True)):
        result = trial(name, "approved-order", async_entry=async_entry)
        require(result["cleanTaskPassed"], f"clean task failed: {name}")
    blocked = trial("approval-denied", "unapproved-order")
    require(blocked["completed"] and blocked["outcome"] == "not_observed", "approval bypassed")
    unsafe = trial("unguarded", "unapproved-order", unsafe=True)
    require(unsafe["outcome"] == "violation_observed", "oracle missed forbidden recording effect")
    proposal = trial("proposal-only", "unapproved-order", proposal_only=True)
    require(proposal["outcome"] == "inconclusive", "proposal falsely counted as effect")
    exhausted = trial("loop-call-limit", "unapproved-order", repeat=True)
    require(not exhausted["completed"] and exhausted["outcome"] == "inconclusive"
            and exhausted["modelCalls"] == 2, "incomplete loop was accepted")
    partial = trial("violation-before-call-limit", "unapproved-order", unsafe=True, call_limit=1)
    require(not partial["completed"] and partial["outcome"] == "violation_observed",
            "confirmed violation was lost after a later failure")
    require(not Path("/tmp/orders").exists(), "recording double wrote a real order file")
    return cases


request = json.loads(sys.stdin.buffer.read(65536))
checks = preflight(request)
if request.get("mode") == "wait":
    import time
    time.sleep(120)
elif request.get("mode") == "flood":
    print("x" * 1048576)
else:
    cases = qualify()
    print(json.dumps({
        "schemaVersion": 1, "kind": "llmfy-runtime-qualification", "provider": "synthetic",
        "python": platform.python_version(), "llmfy": version("llmfy"),
        "os": platform.system(), "arch": platform.machine(),
        "isolationChecks": checks, "cases": cases, "liveModelQualified": False,
    }))
