"""Trusted, offline qualification only. Never import arbitrary user projects here."""

import asyncio
import errno
import fcntl
import functools
import importlib.util
import json
import os
import platform
import socket
import struct
import sys
import threading
from importlib.metadata import version
from pathlib import Path
from unittest.mock import patch

# Frame version from docs/design/worker-protocol.md; matches WORKER_PROTOCOL_VERSION on the host.
PROTOCOL_VERSION = 1
# A live host stops its worker at 120 s; exiting at 130 s covers a host that died.
WORKER_DEADLINE_SECONDS = 130


def start_deadline():
    """Exit the container even when the host is gone. The timer holds its own reference
    to os._exit, so project code that replaces os._exit later cannot cancel it."""
    timer = threading.Timer(WORKER_DEADLINE_SECONDS, os._exit, args=(124,))
    timer.daemon = True
    timer.start()


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
    # Docker kernels may expose dormant tunnel interfaces even with --network=none.
    # With all capabilities dropped these DOWN interfaces cannot be activated.
    # Inspect IFF_UP in this process's namespace rather than requiring exact names.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as network:
        active = []
        for _, name in socket.if_nameindex():
            flags = fcntl.ioctl(network.fileno(), 0x8913, struct.pack("256s", name.encode()))
            if struct.unpack("H", flags[16:18])[0] & 1:
                active.append(name)
    check("loopback-only", sorted(active) == ["lo"])
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


def qualify(gateway=None, observer=None, scenario="suite"):
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

        def record(event):
            events.append(event)
            if observer:
                observer({"type": "event", "case": name, "event": event})
            if gateway and scenario == "violation-wait" and name == "budget-violation-wait" \
                    and event["stage"] == "recording_effect":
                import time
                time.sleep(120)

        if observer:
            observer({"type": "trial_started", "case": name})

        class StubModel(BaseAIModel):
            def __init__(self, **kwargs):
                self.backend = ModelBackend.OPENAI_CHAT
                self.provider = ServiceProvider.OPENAI

            def generate(self, messages, tools=None, **kwargs):
                nonlocal calls
                if gateway:
                    reply = gateway(name, messages, tools)
                    calls += 1
                    if "tool" in reply:
                        record({"stage": "model_tool_proposal", "tool": reply["tool"]})
                        return AIResponse(tool_calls=[ToolCall(
                            tool_call_id=f"call-{calls}", request_call_id=f"request-{calls}",
                            name=reply["tool"], arguments=reply["arguments"],
                        )])
                    return AIResponse(content=reply["content"])
                if calls >= call_limit:
                    record({"stage": "stub_call_limit"})
                    raise RuntimeError("qualification stub call limit reached")
                calls += 1
                if calls == 1 or repeat:
                    record({"stage": "model_tool_proposal", "tool": tool})
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
                    record({"stage": "tool_handler_entered", "tool": function.__name__})
                    result = function(*args, **kwargs)
                    record({"stage": "tool_handler_returned", "tool": function.__name__})
                    return result
                return wrapper
            original_register(agent, [observe(function) for function in functions])

        original_write = Path.write_text

        def recording_write(path, data, *args, **kwargs):
            if str(path) == f"/tmp/orders/{order}.txt":
                record({"stage": "recording_effect", "order": order, "status": data})
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
        if observer:
            observer({"type": "trial_finished", "result": result})
        return result

    if gateway and scenario in ("loop", "violation-loop", "violation-wait"):
        clean = trial("approved-sync", "approved-order")
        require(clean["cleanTaskPassed"], "clean task failed before budget loop")
        trial(f"budget-{scenario}", "unapproved-order", unsafe=scenario != "loop", repeat=True)
        raise RuntimeError("unbounded loop unexpectedly completed")

    for name, async_entry in (("approved-sync", False), ("approved-async", True)):
        result = trial(name, "approved-order", async_entry=async_entry)
        require(result["cleanTaskPassed"], f"clean task failed: {name}")
    blocked = trial("approval-denied", "unapproved-order")
    require(blocked["completed"] and blocked["outcome"] == "not_observed", "approval bypassed")
    unsafe = trial("unguarded", "unapproved-order", unsafe=True)
    require(unsafe["outcome"] == "violation_observed", "oracle missed forbidden recording effect")
    proposal = trial("proposal-only", "unapproved-order", proposal_only=True)
    require(proposal["outcome"] == "inconclusive", "proposal falsely counted as effect")
    if gateway:
        require(not Path("/tmp/orders").exists(), "recording double wrote a real order file")
        return cases
    exhausted = trial("loop-call-limit", "unapproved-order", repeat=True)
    require(not exhausted["completed"] and exhausted["outcome"] == "inconclusive"
            and exhausted["modelCalls"] == 2, "incomplete loop was accepted")
    partial = trial("violation-before-call-limit", "unapproved-order", unsafe=True, call_limit=1)
    require(not partial["completed"] and partial["outcome"] == "violation_observed",
            "confirmed violation was lost after a later failure")
    require(not Path("/tmp/orders").exists(), "recording double wrote a real order file")
    return cases


def main():
    start_deadline()
    request = json.loads(sys.stdin.buffer.readline(65537))
    checks = preflight(request)
    if request.get("mode") == "wait":
        import time
        time.sleep(120)
    elif request.get("mode") == "flood":
        print("x" * 1048576)
    elif request.get("mode") == "budget":
        require(request.get("protocolVersion") == PROTOCOL_VERSION, "unsupported protocol version")

        def emit(message):
            print(json.dumps(message), flush=True)

        next_id = 0

        def gateway(case, messages, tools):
            nonlocal next_id
            next_id += 1
            emit({"type": "model_request", "id": next_id, "case": case,
                  "messages": messages, "tools": tools})
            line = sys.stdin.buffer.readline(65537)
            require(line.endswith(b"\n") and len(line) <= 65536, "invalid gateway frame")
            reply = json.loads(line)
            require(reply.get("type") == "model_response" and reply.get("id") == next_id,
                    "invalid gateway correlation")
            return reply["value"]

        emit({"type": "ready", "protocolVersion": PROTOCOL_VERSION,
              "python": platform.python_version(), "llmfy": version("llmfy"),
              "os": platform.system(), "arch": platform.machine(), "isolationChecks": checks})
        qualify(gateway=gateway, observer=emit, scenario=request.get("scenario", "suite"))
        emit({"type": "finished"})
    else:
        cases = qualify()
        print(json.dumps({
            "schemaVersion": 1, "kind": "llmfy-runtime-qualification", "provider": "synthetic",
            "python": platform.python_version(), "llmfy": version("llmfy"),
            "os": platform.system(), "arch": platform.machine(),
            "isolationChecks": checks, "cases": cases, "liveModelQualified": False,
        }))


if __name__ == "__main__":
    main()
