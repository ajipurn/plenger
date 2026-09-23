"""Descriptor-relative input capture. Never follows target symlinks or imports target code."""

import os
import stat
from pathlib import Path
from typing import Any

import yaml
from yaml.tokens import AliasToken, AnchorToken, TagToken

from plenger.domain import ProjectConfig

EXCLUDED = {
    ".git",
    ".plenger",
    ".Wonderkit",
    ".venv",
    "venv",
    "node_modules",
    "build",
    "dist",
    "vendor",
    "__pycache__",
}

PRIVATE_DIRECTORY = ".plenger"
LEGACY_PRIVATE_DIRECTORY = ".Wonderkit"
CONFIG_FILE = "plenger.yaml"
LEGACY_CONFIG_FILE = "Wonderkit.yaml"

SCANNER_INPUT_NAMES = {
    "Cargo.toml",
    "Cargo.lock",
    "Gemfile",
    "Gemfile.lock",
    "Pipfile",
    "Pipfile.lock",
    "composer.json",
    "composer.lock",
    "go.mod",
    "go.sum",
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "poetry.lock",
    "pyproject.toml",
    "requirements.txt",
    "requirements-dev.txt",
    "uv.lock",
    "yarn.lock",
}
SCANNER_INPUT_EXTENSIONS = {
    ".cfg",
    ".conf",
    ".go",
    ".ini",
    ".java",
    ".js",
    ".jsx",
    ".md",
    ".php",
    ".rs",
    ".sh",
    ".sql",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}


class WorkspaceError(ValueError):
    pass


def _directory_entry_matches(directory: int, name: str, expected: os.stat_result) -> bool:
    try:
        current = os.stat(name, dir_fd=directory, follow_symlinks=False)
    except OSError:
        return False
    return (
        stat.S_ISREG(current.st_mode)
        and current.st_nlink == 1
        and (current.st_dev, current.st_ino) == (expected.st_dev, expected.st_ino)
    )


def read_regular(
    directory: int,
    name: str,
    limit: int,
    *,
    expected_identity: tuple[int, int] | None = None,
) -> bytes:
    if not name or name in {".", ".."} or "/" in name or "\\" in name:
        raise WorkspaceError("invalid_path")
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        before = os.fstat(fd)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size > limit
            or expected_identity is not None
            and (before.st_dev, before.st_ino) != expected_identity
        ):
            raise WorkspaceError("not_regular_or_too_large")
        if not _directory_entry_matches(directory, name, before):
            raise WorkspaceError("file_changed_or_too_large")
        data = bytearray()
        while len(data) <= limit:
            chunk = os.read(fd, min(65536, limit + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(fd)
        if (
            (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
            or len(data) > limit
            or not _directory_entry_matches(directory, name, after)
        ):
            raise WorkspaceError("file_changed_or_too_large")
        return bytes(data)
    finally:
        os.close(fd)


def read_regular_stable(directory: int, name: str, limit: int) -> bytes:
    """Read a name only if it is still the inode observed before opening it."""

    info = os.stat(name, dir_fd=directory, follow_symlinks=False)
    return read_regular(
        directory,
        name,
        limit,
        expected_identity=(info.st_dev, info.st_ino),
    )


class UniqueLoader(yaml.SafeLoader):
    def construct_mapping(self, node: yaml.MappingNode, deep: bool = False) -> dict[Any, Any]:
        result: dict[Any, Any] = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if not isinstance(key, str) or key in result:
                raise WorkspaceError("duplicate_or_invalid_key")
            result[key] = self.construct_object(value_node, deep=deep)
        return result


def parse_config(raw: bytes) -> ProjectConfig:
    if len(raw) > 16384:
        raise WorkspaceError("config_too_large")
    try:
        depth = 0
        for token in yaml.scan(raw):
            if isinstance(token, (AliasToken, AnchorToken, TagToken)):
                raise WorkspaceError("yaml_reference_or_tag_forbidden")
            if type(token).__name__ in {
                "BlockMappingStartToken",
                "BlockSequenceStartToken",
                "FlowMappingStartToken",
                "FlowSequenceStartToken",
            }:
                depth += 1
            if type(token).__name__ in {
                "BlockEndToken",
                "FlowMappingEndToken",
                "FlowSequenceEndToken",
            }:
                depth -= 1
            if depth > 8:
                raise WorkspaceError("config_too_deep")
        value = yaml.load(raw, Loader=UniqueLoader)
        return ProjectConfig.model_validate(value)
    except (yaml.YAMLError, ValueError, TypeError, RecursionError):
        raise WorkspaceError("invalid_config") from None


def root_fd(root: Path) -> int:
    try:
        descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        raise WorkspaceError("invalid_root") from None
    info = os.fstat(descriptor)
    if not stat.S_ISDIR(info.st_mode) or info.st_nlink < 1:
        os.close(descriptor)
        raise WorkspaceError("invalid_root")
    return descriptor


def open_directory_stable(directory: int, name: str, expected_identity: tuple[int, int]) -> int:
    """Open a child directory only if it is still the observed directory inode."""

    if not name or name in {".", ".."} or "/" in name or "\\" in name:
        raise WorkspaceError("invalid_path")
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
    try:
        opened = os.fstat(fd)
        if not stat.S_ISDIR(opened.st_mode) or (opened.st_dev, opened.st_ino) != expected_identity:
            raise WorkspaceError("directory_changed")
        return fd
    except BaseException:
        os.close(fd)
        raise


def _existing_name(directory: int, names: tuple[str, ...], default: str) -> str:
    for name in names:
        try:
            os.stat(name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            continue
        return name
    return default


def private_directory_name(directory: int) -> str:
    """Prefer the current state directory while continuing to use legacy data."""

    return _existing_name(
        directory,
        (PRIVATE_DIRECTORY, LEGACY_PRIVATE_DIRECTORY),
        PRIVATE_DIRECTORY,
    )


def config_filename(directory: int) -> str:
    """Read new config first and fall back to the existing Wonderkit filename."""

    return _existing_name(directory, (CONFIG_FILE, LEGACY_CONFIG_FILE), CONFIG_FILE)


def load_config(root: Path) -> ProjectConfig:
    fd = root_fd(root)
    try:
        return parse_config(read_regular_stable(fd, config_filename(fd), 16384))
    finally:
        os.close(fd)


def initialize(root: Path) -> bool:
    fd = root_fd(root)
    try:
        existing_config = config_filename(fd)
        if existing_config != CONFIG_FILE:
            parse_config(read_regular_stable(fd, existing_config, 16384))
            return False
        try:
            out = os.open(
                CONFIG_FILE,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=fd,
            )
        except FileExistsError:
            parse_config(read_regular_stable(fd, CONFIG_FILE, 16384))
            return False
        with os.fdopen(out, "w") as stream:
            stream.write("schema_version: 1\nprofile: deterministic\n")
        return True
    finally:
        os.close(fd)


def capture(
    root: Path, config: ProjectConfig, *, include_scanner_inputs: bool = False
) -> tuple[dict[str, str], list[dict[str, str]]]:
    files: dict[str, str] = {}
    skipped: list[dict[str, str]] = []
    total = 0
    visited = 0

    def walk(fd: int, prefix: str, depth: int) -> None:
        nonlocal total, visited
        if depth > 64:
            raise WorkspaceError("directory_depth_limit")
        with os.scandir(fd) as entries:
            for entry in entries:
                visited += 1
                if visited > config.max_files:
                    raise WorkspaceError("file_count_limit")
                name = entry.name
                path = prefix + name
                if name in EXCLUDED or name.startswith(".env") or name.endswith((".pem", ".key")):
                    skipped.append({"path": path, "reason": "excluded"})
                    continue
                if entry.is_symlink():
                    skipped.append({"path": path, "reason": "symlink"})
                    continue
                if entry.is_dir(follow_symlinks=False):
                    info = entry.stat(follow_symlinks=False)
                    child = open_directory_stable(fd, name, (info.st_dev, info.st_ino))
                    try:
                        walk(child, path + "/", depth + 1)
                    finally:
                        os.close(child)
                elif not entry.is_file(follow_symlinks=False):
                    skipped.append({"path": path, "reason": "not_regular"})
                elif name.endswith(".py") or (
                    include_scanner_inputs
                    and (
                        name in SCANNER_INPUT_NAMES
                        or name.endswith(".lock")
                        or (name.startswith("requirements") and name.endswith(".txt"))
                        or Path(name).suffix.lower() in SCANNER_INPUT_EXTENSIONS
                    )
                ):
                    try:
                        info = entry.stat(follow_symlinks=False)
                        raw = read_regular(
                            fd,
                            name,
                            config.max_file_bytes,
                            expected_identity=(info.st_dev, info.st_ino),
                        )
                        total += len(raw)
                        if total > config.max_total_bytes:
                            raise WorkspaceError("total_size_limit")
                        files[path] = raw.decode("utf-8")
                    except UnicodeDecodeError:
                        skipped.append({"path": path, "reason": "unsupported_encoding"})
                else:
                    skipped.append({"path": path, "reason": "unsupported_format"})

    fd = root_fd(root)
    try:
        walk(fd, "", 0)
    finally:
        os.close(fd)
    return files, skipped
