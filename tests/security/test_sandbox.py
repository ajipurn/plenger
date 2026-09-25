import sys
from pathlib import Path

from plenger.runner import sandbox


def _linux_command(monkeypatch, socket_path: Path) -> list[str]:
    monkeypatch.setattr(sandbox.platform, "system", lambda: "Linux")
    monkeypatch.setattr(sandbox, "_linux_bwrap", lambda: "/usr/bin/bwrap")
    command, in_sandbox = sandbox.confined_worker_command(socket_path)
    assert in_sandbox == str(sandbox.LINUX_BROKER_MOUNT / socket_path.name)
    return command


def _bind_pairs(command: list[str]) -> list[tuple[str, str, str]]:
    return [
        (command[index], command[index + 1], command[index + 2])
        for index, value in enumerate(command[:-2])
        if value in {"--bind", "--ro-bind", "--ro-bind-try", "--bind-try"}
    ]


def test_linux_worker_does_not_expose_the_host_root_or_other_sockets(monkeypatch, tmp_path):
    socket_path = tmp_path / "job" / "broker.sock"
    socket_path.parent.mkdir()
    command = _linux_command(monkeypatch, socket_path)
    separator = command.index("--")
    options = command[:separator]
    binds = _bind_pairs(options)

    assert all(source != "/" for _, source, _ in binds)
    assert all(not source.startswith(("/run", "/var/run", "/tmp")) for _, source, _ in binds)
    assert ("--ro-bind", str(socket_path.parent.resolve()), "/run/plenger-active-broker") in binds
    for flag in ("--unshare-all", "--new-session", "--die-with-parent", "--clearenv"):
        assert flag in options
    assert options[options.index("--cap-drop") + 1] == "ALL"
    assert command[separator + 1] == sys.executable


def test_linux_worker_binds_the_interpreter_read_only(monkeypatch, tmp_path):
    socket_path = tmp_path / "broker.sock"
    command = _linux_command(monkeypatch, socket_path)
    binds = _bind_pairs(command[: command.index("--")])
    sources = {source for flag, source, _ in binds if flag.startswith("--ro-bind")}

    assert str(Path(sys.base_prefix).resolve()) in sources or any(
        str(Path(sys.base_prefix).resolve()).startswith(source + "/") for source in sources
    )
    assert all(flag.startswith("--ro-bind") for flag, _, _ in binds)
