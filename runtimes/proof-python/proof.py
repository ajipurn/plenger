"""Proof test harness (docs/design/proof-tests.md). Runs one test file against a copy of
the project in a networkless container and reports what it observed. The host decides
the outcome. Without arguments this is the worker; `case NAME` runs one test case."""

import errno
import fcntl
import hashlib
import importlib.machinery
import importlib.util
import json
import os
import platform
import secrets
import socket
import struct
import subprocess
import sys
import threading
import traceback
import types
from importlib.metadata import version
from pathlib import Path

# Frame version from docs/design/worker-protocol.md; matches WORKER_PROTOCOL_VERSION.
PROTOCOL_VERSION = 2
# The host stops a run at 60 s; exiting at 70 s covers a host that died.
DEADLINE_SECONDS = 70
CASE_SECONDS = 20
PROJECT = "/tmp/project"
ROOT = "/tmp/proof"
BASE = ROOT + "/base"
TEST = ROOT + "/test/test_proof.py"
EFFECTS = ROOT + "/effects"
HARNESS = "/opt/plenger/"
PACKAGES = ["fastapi", "flask", "httpx", "jinja2", "langchain-core", "numpy", "openai",
            "pydantic", "pyyaml", "requests", "sqlalchemy", "werkzeug", "itsdangerous"]
LIMITS = {"output": 8192, "error": 2048, "effects": 32, "target": 512, "request": 6 * 2**20}
WEAKNESSES = ("CWE-22", "CWE-78")
SHELLS = {"sh", "bash", "dash", "zsh"}

# Test code runs in the case process. What the harness does while or after it runs uses
# these references, saved before the test loads, so a test that replaces os.path.normpath
# or json.dumps cannot change what the harness sees or reports.
_getframe = sys._getframe
_dumps = json.dumps
_write = os.write
_close = os.close
_exit = os._exit
_fsdecode = os.fsdecode
_isabs = os.path.isabs
_normpath = os.path.normpath
_join = os.path.join
_getcwd = os.getcwd
_realpath = os.path.realpath
_basename = os.path.basename
_environ = os.environ
_monitoring = sys.monitoring
_PathLike = os.PathLike
_ModuleType = types.ModuleType


def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def start_deadline():
    timer = threading.Timer(DEADLINE_SECONDS, os._exit, args=(124,))
    timer.daemon = True
    timer.start()


def preflight(request):
    """The isolation checks of the llmfy worker, run before any project file exists."""
    checks = []

    def check(name, condition):
        if not condition:
            raise RuntimeError(f"isolation check failed: {name}")
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
    try:
        Path("/opt/plenger/write-probe").write_text("probe")
    except OSError as error:
        check("image-write-denied", error.errno in (errno.EROFS, errno.EACCES))
    else:
        raise RuntimeError("isolation check failed: image-write-denied")
    probe = Path("/tmp/private-probe")
    probe.write_text("private")
    check("temporary-write", probe.read_text() == "private")
    probe.unlink()
    return checks


def safe_path(name):
    return (isinstance(name, str) and 0 < len(name) <= 512 and not name.startswith("/")
            and all(part not in ("", ".", "..") and not part.startswith(".")
                    for part in name.split("/")))


def ranges(value, paths):
    if not isinstance(value, list) or not 0 < len(value) <= 8:
        raise RuntimeError("invalid ranges")
    for item in value:
        if (not isinstance(item, dict) or item.get("path") not in paths
                or not isinstance(item.get("line"), int) or not isinstance(item.get("endLine"), int)
                or not 1 <= item["line"] <= item["endLine"]):
            raise RuntimeError("invalid range")
    return value


def clip(text, marker):
    """Cut long text, keeping the marker when it is there."""
    limit = LIMITS["target"]
    if len(text) <= limit:
        return text
    index = text.find(marker)
    start = 0 if index < 0 else max(0, min(index - 200, len(text) - limit))
    return text[start:start + limit]


def digest(sources):
    state = hashlib.sha256()
    for root, _, files in sorted(os.walk(PROJECT)):
        for name in sorted(files):
            path = os.path.join(root, name)
            if os.path.islink(path):
                state.update(b"link:" + path.encode())
                continue
            state.update(path.encode() + b"\0")
            with open(path, "rb") as handle:
                state.update(handle.read())
    return state.hexdigest()


def stage_project(sources):
    """Write the sources read-only, replacing whatever a case left in the folder."""
    if os.path.isdir(PROJECT):
        os.chmod(PROJECT, 0o700)
        for root, dirs, _ in os.walk(PROJECT):
            for name in dirs:
                path = os.path.join(root, name)
                if not os.path.islink(path):
                    os.chmod(path, 0o700)
        for root, dirs, files in os.walk(PROJECT, topdown=False):
            for name in files:
                os.unlink(os.path.join(root, name))
            for name in dirs:
                path = os.path.join(root, name)
                os.unlink(path) if os.path.islink(path) else os.rmdir(path)
    else:
        os.makedirs(PROJECT, mode=0o700)
    for item in sources:
        path = Path(PROJECT, item["path"])
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        path.write_text(item["content"])
        path.chmod(0o400)
    for root, dirs, _ in os.walk(PROJECT):
        for name in dirs:
            os.chmod(os.path.join(root, name), 0o500)
    os.chmod(PROJECT, 0o500)


def worker():
    start_deadline()
    line = sys.stdin.buffer.readline(LIMITS["request"] + 1)
    if not line.endswith(b"\n") or len(line) > LIMITS["request"]:
        raise RuntimeError("invalid request frame")
    request = json.loads(line)
    if request.get("protocolVersion") != PROTOCOL_VERSION:
        raise RuntimeError("unsupported protocol version")
    checks = preflight(request)
    emit({"type": "ready", "protocolVersion": PROTOCOL_VERSION,
          "python": platform.python_version(),
          "packages": {name: version(name) for name in PACKAGES},
          "isolationChecks": checks})

    marker = request["marker"]
    if not (isinstance(marker, str) and marker.startswith("PLENGER_") and len(marker) == 40
            and all(c in "0123456789abcdef" for c in marker[8:])):
        raise RuntimeError("invalid marker")
    if request.get("weakness") not in WEAKNESSES:
        raise RuntimeError("invalid weakness")
    sources = request["sources"]
    if not isinstance(sources, list) or not sources or any(
            not isinstance(item, dict) or not safe_path(item.get("path"))
            or not isinstance(item.get("content"), str) for item in sources):
        raise RuntimeError("invalid sources")
    if len({item["path"] for item in sources}) != len(sources):
        raise RuntimeError("duplicate source")
    if sum(len(item["content"].encode()) for item in sources) > 4 * 2**20:
        raise RuntimeError("source limit")
    paths = {item["path"] for item in sources}
    entry = ranges(request["entry"], paths)
    cited = ranges(request["cited"], paths)
    test = request["test"]
    if not isinstance(test, str) or len(test.encode()) > 16384:
        raise RuntimeError("invalid test")

    stage_project(sources)
    expected = digest(sources)
    os.makedirs(ROOT + "/test", mode=0o700)
    Path(TEST).write_text(test)
    Path(TEST).chmod(0o400)
    os.makedirs(BASE, mode=0o700)
    os.makedirs(EFFECTS, mode=0o700)
    guarded = [f"{ROOT}/outside-{marker}", f"{ROOT}/base-{marker}"]
    first, second = secrets.randbelow(9000) + 1000, secrets.randbelow(9000) + 1000
    effect = f"{EFFECTS}/{marker}"
    command = f"echo $(({first}+{second}))>{effect}"
    config = {
        "marker": marker,
        "weakness": request["weakness"],
        "guarded": guarded,
        "canary": f"{guarded[0]}/canary.txt",
        "sibling": f"{guarded[1]}/canary.txt",
        "payloads": [f";{command}", f"$({command})", f"`{command}`", f"|{command}",
                     f"&&{command}", f"||{command}", f"\n{command}\n"],
        "watched": sorted({item["path"] for item in entry + cited}),
    }
    for name in ("intended", "weakness"):
        for folder in guarded:
            os.makedirs(folder, mode=0o700, exist_ok=True)
            Path(folder, "canary.txt").write_text(f"canary {marker}\n")
        result = run_case(name, config)
        canary = False
        try:
            with open(effect, encoding="utf-8") as handle:
                canary = handle.read(64).strip() == str(first + second)
            os.unlink(effect)
        except OSError:
            pass
        replaced = result["replaced"]
        if digest(sources) != expected:
            replaced.append("project files")
            stage_project(sources)
        emit({"type": "case", "name": name, "status": result["status"],
              "failedAt": result["failedAt"], "error": result["error"],
              "output": result["output"], "effects": result["effects"],
              "effectsDropped": result["effectsDropped"], "reached": result["reached"],
              "replaced": replaced[:64], "canary": canary})
    emit({"type": "finished", "completed": True})


def run_case(name, config):
    """Run one case in its own process group, so hooks and module state start fresh."""
    read_end, write_end = os.pipe()
    chunks = []

    def collect():
        total = 0
        with os.fdopen(read_end, "rb") as handle:
            while chunk := handle.read(65536):
                total += len(chunk)
                if total <= 2**20:
                    chunks.append(chunk)

    reader = threading.Thread(target=collect, daemon=True)
    reader.start()
    process = subprocess.Popen(
        [sys.executable, "-I", "/opt/plenger/proof.py", "case", name],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        cwd=BASE, pass_fds=(write_end,), start_new_session=True,
        env={"HOME": "/tmp", "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
             "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1"})
    os.close(write_end)
    timed_out = False
    try:
        output, _ = process.communicate(
            json.dumps({**config, "resultFd": write_end}).encode(), timeout=CASE_SECONDS)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(process.pid, 9)
        except OSError:
            pass
        output, _ = process.communicate()
    try:
        os.killpg(process.pid, 9)
    except OSError:
        pass
    reader.join(5)
    text = output.decode("utf-8", "replace")[:LIMITS["output"]]
    result = None
    try:
        result = json.loads(b"".join(chunks))
    except ValueError:
        pass
    if timed_out or not isinstance(result, dict):
        return {"status": "timeout" if timed_out else "error", "failedAt": None if timed_out
                else "test", "error": None if timed_out else "The case ended without a result.",
                "output": text, "effects": [], "effectsDropped": 0, "reached": {},
                "replaced": []}
    return {**result, "output": text}


# --- One case, in its own process ----------------------------------------------------


class Frames:
    """Who is running: the project, the test, the harness or a library."""

    def __init__(self):
        self.local = threading.local()

    @staticmethod
    def kind(filename):
        if filename.startswith(PROJECT + "/"):
            return "project"
        if filename == TEST:
            return "test"
        if filename.startswith(HARNESS):
            return "harness"
        return "library"

    def walk(self, frame):
        """Innermost non-library kind, innermost and outermost project frames."""
        first = None
        inner = outer = None
        while frame is not None:
            filename = frame.f_code.co_filename
            kind = self.kind(filename)
            if kind != "library" and first is None:
                first = kind
            if kind == "project":
                place = {"path": filename[len(PROJECT) + 1:], "line": frame.f_lineno or 1}
                inner = inner or place
                outer = place
            frame = frame.f_back
        return first, inner, outer


def absolute(value):
    if isinstance(value, int) or value is None:
        return None
    try:
        text = _fsdecode(value)
    except TypeError:
        return None
    return _normpath(text if _isabs(text) else _join(_getcwd(), text))


def under(path, folder):
    return path == folder or path.startswith(folder + "/")


FILE_EVENTS = {
    "open": (0,), "os.remove": (0,), "os.rename": (0, 1), "os.mkdir": (0,),
    "os.rmdir": (0,), "os.symlink": (0, 1), "os.link": (0, 1), "os.truncate": (0,),
    "os.listdir": (0,), "os.scandir": (0,), "os.chmod": (0,), "os.chown": (0,),
    "os.utime": (0,), "shutil.copyfile": (0, 1), "shutil.copytree": (0, 1),
    "shutil.rmtree": (0,), "shutil.move": (0, 1),
}
PROCESS_EVENTS = {"subprocess.Popen", "os.system", "os.posix_spawn", "os.exec", "os.spawn",
                  "os.fork", "os.forkpty", "pty.spawn"}
WATCHED_MODULES = ("os", "posixpath", "pathlib", "shlex", "subprocess", "shutil", "builtins",
                   "io", "json")


class Case:
    def __init__(self, config):
        self.config = config
        self.frames = Frames()
        self.effects = []
        self.dropped = 0
        self.replaced = []
        self.hits = {}
        self.watched = {f"{PROJECT}/{path}": path for path in config["watched"]}
        self.guarded = config["guarded"]
        self.marker = config["marker"]
        # The watched state as the project and its packages left it; set after the test loads.
        self.baseline = None

    def drift(self):
        """Names whose value differs from the baseline, settings inside base() aside."""
        if self.baseline is None:
            return []
        now = state_of()
        return [key for key in self.baseline.keys() | now.keys()
                if self.baseline.get(key) != now.get(key)
                and not (key.startswith("environment ") and allowed_value(now.get(key)))]

    def record(self, effect):
        # A change undone before the case ends still counts while the effect happens.
        self.replaced += self.drift()
        if len(self.effects) < LIMITS["effects"]:
            self.effects.append(effect)
        else:
            self.dropped += 1

    def audit(self, event, args):
        local = self.frames.local
        if getattr(local, "busy", False):
            return
        if event not in FILE_EVENTS and event not in PROCESS_EVENTS and event != "os.chdir":
            return
        local.busy = True
        try:
            first, inner, outer = self.frames.walk(_getframe(1))
            if first == "harness":
                return
            if event == "os.chdir":
                # Relative paths in the project resolve against the working directory, so
                # moving it next to a guarded folder would fake a traversal.
                if first == "test":
                    raise PermissionError("The test may not change the working directory.")
            elif event in PROCESS_EVENTS:
                self.process(event, args, first, inner, outer)
            else:
                self.file(event, args, first, inner, outer)
        finally:
            local.busy = False

    def process(self, event, args, first, inner, outer):
        if first == "test":
            raise PermissionError("The test may not start processes; call the project code.")
        shell = event == "os.system"
        if event == "subprocess.Popen":
            argv = args[1] if isinstance(args[1], (list, tuple)) else [args[1]]
        elif event == "os.system":
            argv = [args[0]]
        elif event in ("os.posix_spawn", "os.exec"):
            argv = list(args[1]) if isinstance(args[1], (list, tuple)) else []
        elif event == "os.spawn":
            argv = list(args[2]) if isinstance(args[2], (list, tuple)) else []
        else:
            argv = []
        words = [_fsdecode(item) if isinstance(item, (str, bytes, _PathLike)) else str(item)
                 for item in argv]
        if len(words) >= 3 and _basename(words[0]) in SHELLS and words[1] == "-c":
            shell = True
        command = " ".join(words) or event
        if self.marker not in command:
            return
        self.record({"kind": "process", "operation": event,
                     "target": clip(command, self.marker), "guarded": False, "shell": shell,
                     "innermost": inner, "outermost": outer})

    def file(self, event, args, first, inner, outer):
        paths = [absolute(args[index]) for index in FILE_EVENTS[event] if index < len(args)]
        paths = [path for path in paths if path]
        writes = event != "open" or (isinstance(args[1], str) and any(
            flag in args[1] for flag in "wax+")) or (len(args) > 2 and isinstance(args[2], int)
                                                       and args[2] & (os.O_WRONLY | os.O_RDWR))
        if event in ("os.listdir", "os.scandir"):
            writes = False
        for path in paths:
            if under(path, EFFECTS):
                # Only a shell the payload injected may create the command canary.
                raise PermissionError("Python code may not touch the command canary.")
            if first == "test" and (
                    any(under(path, folder) for folder in self.guarded)
                    or under(path, "/opt/plenger") or under(path, ROOT + "/test")
                    or (writes and under(path, PROJECT)) or event in ("os.symlink", "os.link")):
                raise PermissionError("The test may not touch this path; call the project code.")
            if any(under(path, folder) for folder in self.guarded):
                self.record({"kind": "file", "operation": event,
                             "target": clip(path, self.marker), "guarded": True, "shell": False,
                             "innermost": inner, "outermost": outer})

    def line(self, code, number):
        path = self.watched.get(code.co_filename)
        if path is not None:
            self.hits.setdefault(path, set()).add(number)
        return _monitoring.DISABLE


def snapshot_stdlib():
    names = {}
    for module_name in WATCHED_MODULES:
        module = sys.modules.get(module_name) or __import__(module_name)
        for name, value in vars(module).items():
            if callable(value) or isinstance(value, type):
                names[f"{module_name}.{name}"] = id(value)
            if isinstance(value, type) and value.__module__ == module_name:
                for attribute, item in vars(value).items():
                    names[f"{module_name}.{name}.{attribute}"] = id(item)
    return names


def state_of():
    """Functions and classes of the watched modules, project classes, the environment and
    the working directory."""
    found = snapshot_stdlib()
    found.update(project_classes())
    found.update({f"environment {key}": value for key, value in _environ.items()})
    found["working directory"] = _getcwd()
    return found


def allowed_value(value):
    """Settings may point the project at the test's folder, and nowhere else."""
    if not isinstance(value, (str, _PathLike)):
        return False
    try:
        path = _realpath(_fsdecode(value))
    except (TypeError, ValueError):
        return False
    return under(path, BASE)


def make_module_type(case, settings):
    """A module class that records names the test sets or deletes, when it does so.
    `settings`: a project module, whose paths may point inside base()."""

    class WatchedModule(_ModuleType):
        def __setattr__(self, name, value):
            first, _, _ = case.frames.walk(_getframe(1))
            if first == "test" and not isinstance(value, _ModuleType) \
                    and not (settings and allowed_value(value)):
                case.replaced.append(f"{self.__name__}.{name}")
            super().__setattr__(name, value)

        def __delattr__(self, name):
            first, _, _ = case.frames.walk(_getframe(1))
            if first == "test":
                case.replaced.append(f"{self.__name__}.{name}")
            super().__delattr__(name)

    return WatchedModule


class WatchedLoader:
    def __init__(self, loader, module_type):
        self._loader = loader
        self._type = module_type

    def __getattr__(self, name):
        return getattr(self._loader, name)

    def create_module(self, spec):
        return self._loader.create_module(spec)

    def exec_module(self, module):
        self._loader.exec_module(module)
        module.__class__ = self._type


def make_finder(module_type):
    class ProjectFinder:
        @classmethod
        def find_spec(cls, name, path=None, target=None):
            spec = importlib.machinery.PathFinder.find_spec(name, path, target)
            if spec is not None and spec.origin and spec.origin.startswith(PROJECT + "/") \
                    and spec.loader is not None:
                spec.loader = WatchedLoader(spec.loader, module_type)
            return spec

        @classmethod
        def invalidate_caches(cls):
            importlib.machinery.PathFinder.invalidate_caches()

    return ProjectFinder


def project_classes():
    found = {}
    for name, module in list(sys.modules.items()):
        filename = getattr(module, "__file__", None) or ""
        if not filename.startswith(PROJECT + "/"):
            continue
        for attribute, value in list(vars(module).items()):
            if isinstance(value, type) and getattr(value, "__module__", None) == name:
                for key, item in vars(value).items():
                    found[f"{name}.{attribute}.{key}"] = id(item)
    return found


def describe(error):
    lines = [f"{type(error).__name__}: {error}"]
    for frame in traceback.extract_tb(error.__traceback__):
        if frame.filename.startswith(PROJECT + "/") or frame.filename == TEST:
            where = frame.filename[len(PROJECT) + 1:] if frame.filename.startswith(PROJECT) \
                else "test_proof.py"
            lines.append(f"  at {where}:{frame.lineno} in {frame.name}")
    return "\n".join(lines[-8:])[:LIMITS["error"]]


class Plenger:
    """The helper a test receives. Its own file operations are the harness's."""

    def __init__(self, config):
        self._config = config

    def base(self):
        return Path(BASE)

    def folder(self, name):
        path = Path(BASE, name)
        if not under(_normpath(str(path)), BASE):
            raise ValueError("folders stay under base()")
        path.mkdir(parents=True, exist_ok=True)
        return path

    def write(self, name, text):
        path = Path(BASE, name)
        if not under(_normpath(str(path)), BASE):
            raise ValueError("files stay under base()")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def read(self, name):
        path = Path(BASE, name)
        if not under(_normpath(str(path)), BASE):
            raise ValueError("files stay under base()")
        return path.read_text()

    def canary(self):
        return Path(self._config["canary"])

    def sibling_canary(self):
        return Path(self._config["sibling"])

    def shell_payloads(self):
        return list(self._config["payloads"])


def case(name):
    config = json.loads(sys.stdin.read())
    result_fd = config["resultFd"]
    # Processes the project starts must not hold the result pipe open.
    os.set_inheritable(result_fd, False)
    state = Case(config)
    module_type = make_module_type(state, settings=True)
    stdlib_type = make_module_type(state, settings=False)
    for module_name in WATCHED_MODULES:
        (sys.modules.get(module_name) or __import__(module_name)).__class__ = stdlib_type
    sys.meta_path.insert(0, make_finder(module_type))
    sys.path.insert(0, PROJECT)
    os.chdir(BASE)
    monitoring = sys.monitoring
    tool = monitoring.COVERAGE_ID
    monitoring.use_tool_id(tool, "plenger")
    monitoring.register_callback(tool, monitoring.events.LINE, state.line)
    sys.addaudithook(state.audit)
    status, failed_at, error = "passed", None, None
    try:
        spec = importlib.util.spec_from_file_location("test_proof", TEST)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        function = getattr(module, f"test_{name}", None)
        if not callable(function):
            raise AttributeError(f"The test has no test_{name} function.")
    except BaseException as caught:  # noqa: BLE001
        status, failed_at, error = "error", "import", describe(caught)
    # The test's top level holds only imports and definitions (the host checks), so
    # nothing it wrote has run yet: these are the modules as the project left them.
    state.baseline = state_of()
    if failed_at is None:
        monitoring.set_events(tool, monitoring.events.LINE)
        try:
            outcome = function(Plenger(config))
            if isinstance(outcome, types.CoroutineType):
                import asyncio
                asyncio.run(outcome)
        except AssertionError as caught:
            status, failed_at, error = "failed", "test", describe(caught)
        except BaseException as caught:  # noqa: BLE001
            status, failed_at, error = "error", "test", describe(caught)
        monitoring.set_events(tool, 0)
    state.replaced += state.drift()
    if state.replaced:
        # Changed code decides nothing; report only what changed.
        result = {"status": "error", "failedAt": "test",
                  "error": "The test changed code the harness watches.", "effects": [],
                  "effectsDropped": 0, "reached": {},
                  "replaced": sorted(set(state.replaced))[:64]}
    else:
        result = {"status": status, "failedAt": failed_at, "error": error,
                  "effects": state.effects, "effectsDropped": state.dropped,
                  "reached": {path: sorted(lines) for path, lines in state.hits.items()},
                  "replaced": []}
    data = _dumps(result).encode()
    while data:
        data = data[_write(result_fd, data):]
    _close(result_fd)
    _exit(0)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "case" and sys.argv[2] in ("intended", "weakness"):
        case(sys.argv[2])
    else:
        worker()
