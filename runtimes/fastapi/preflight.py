"""Isolation checks for the FastAPI worker. Runs before any project module is imported."""

import errno
import fcntl
import os
import platform
import socket
import struct
import sys
import threading
from pathlib import Path

# Frame version from docs/design/worker-protocol.md; matches WORKER_PROTOCOL_VERSION on the host.
PROTOCOL_VERSION = 2
# The host stops this worker at 300 s; exiting at 310 s covers a host that died.
WORKER_DEADLINE_SECONDS = 310
# FASTAPI_WORKER in src/redteam/constants.ts; the host launches with exactly these limits.
MEMORY_BYTES = 1024 * 1024 * 1024
PROCESS_LIMIT = 128


def start_deadline():
    """Exit even when the host is gone. The timer keeps its own reference to os._exit."""
    timer = threading.Timer(WORKER_DEADLINE_SECONDS, os._exit, args=(124,))
    timer.daemon = True
    timer.start()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def preflight(request):
    """Prove the container controls. A private network with the disposable services is
    allowed; a route out of it is not."""
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
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as network:
        active = []
        for _, name in socket.if_nameindex():
            flags = fcntl.ioctl(network.fileno(), 0x8913, struct.pack("256s", name.encode()))
            if struct.unpack("H", flags[16:18])[0] & 1:
                active.append(name)
    # Loopback plus exactly one interface on the private service network.
    check("private-network-only", "lo" in active and len(active) == 2)
    routes = [line.split() for line in Path("/proc/net/route").read_text().splitlines()[1:]]
    check("no-default-route", not any(route[1] == "00000000" for route in routes if len(route) > 1))
    mounts = [line.split() for line in Path("/proc/mounts").read_text().splitlines()]
    check("read-only-root", any(item[1] == "/" and "ro" in item[3].split(",") for item in mounts))
    check("private-temporary-files", any(item[1] == "/tmp" and item[2] == "tmpfs" for item in mounts))
    cgroup = Path("/sys/fs/cgroup")
    check("memory-limit", (cgroup / "memory.max").read_text().strip() == str(MEMORY_BYTES))
    check("no-swap", (cgroup / "memory.swap.max").read_text().strip() == "0")
    check("process-limit", (cgroup / "pids.max").read_text().strip() == str(PROCESS_LIMIT))
    quota, period = (cgroup / "cpu.max").read_text().split()
    check("cpu-limit", quota != "max" and int(quota) == int(period))
    check("no-host-file", not Path(request["hostMarker"]).exists())
    check("no-host-environment", "PLENGER_HOST_SENTINEL" not in os.environ)
    check("no-container-socket", not Path("/var/run/docker.sock").exists()
          and not Path("/run/podman/podman.sock").exists())
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
