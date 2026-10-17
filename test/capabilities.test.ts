import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Capability, Inventory } from "../src/inventory/model.ts";
import { scan } from "../src/scan.ts";

async function project(
  files: Record<string, string>,
): Promise<{ root: string; inventory: Inventory }> {
  const root = await mkdtemp(join(tmpdir(), "plenger-capabilities-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return { root, inventory: (await scan(root)).inventory };
}

const summary = (capabilities: Capability[]) =>
  capabilities.map(
    (item) =>
      `${item.kind} ${item.target} [${item.inputs.map((input) => `${input.text}:${input.source}`)}]`,
  );

describe("capabilities of Python tools", () => {
  let root: string;
  let inventory: Inventory;
  const tool = (name: string) => inventory.tools.find((candidate) => candidate.name === name);

  beforeAll(async () => {
    ({ root, inventory } = await project({
      "tools.py": `import os
import subprocess
from pathlib import Path

from langchain_core.tools import tool


@tool
def save(path: str, text: str) -> str:
    """Save text."""
    with open(path, "w") as handle:
        handle.write(text)
    return "ok"


@tool
def load(path: str) -> str:
    """Load text."""
    return open(path).read()


@tool
def note(name: str, text: str) -> str:
    """Write a note."""
    Path(f"notes/{name}.md").write_text(text)
    return "ok"


def ping(host: str, retries: int):
    if retries > 0:
        return pong(host, retries - 1)
    return subprocess.run(["ping", "-c", "1", host])


def pong(host: str, retries: int):
    return ping(host, retries)


@tool
def check(host: str) -> str:
    """Check a host."""
    return ping(host, 3)


class Shell:
    def run(self, command: str):
        return os.system(command)


@tool
def shell(command: str) -> str:
    """Run a command."""
    return Shell().run(command)


@tool
def configured() -> str:
    """Show configuration."""
    key = os.environ["API_KEY"]
    return key[:4]
`,
    }));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("tells reading from writing by the mode open() gets", () => {
    expect(summary(tool("save")?.capabilities ?? [])).toEqual(["file_write open [path:param]"]);
    expect(summary(tool("load")?.capabilities ?? [])).toEqual(["file_read open [path:param]"]);
  });

  it("takes a pathlib effect's input from the path it was built from", () => {
    expect(summary(tool("note")?.capabilities ?? [])).toEqual([
      "file_write pathlib.Path().write_text [name:param]",
    ]);
  });

  it("follows recursive project functions without looping", () => {
    const [capability] = tool("check")?.capabilities ?? [];
    expect(capability).toMatchObject({ kind: "process", target: "subprocess.run" });
    expect(capability?.inputs).toEqual([{ text: "host", source: "param", from: ["host"] }]);
    expect(capability?.via.map((site) => site.line)).toEqual([42]);
  });

  it("follows methods of project classes and binds arguments past self", () => {
    expect(summary(tool("shell")?.capabilities ?? [])).toEqual([
      "process os.system [command:param]",
    ]);
  });

  it("reports environment reads as secrets", () => {
    expect(summary(tool("configured")?.capabilities ?? [])).toEqual([
      "secret os.environ.API_KEY []",
    ]);
  });
});

describe("capabilities of JS/TS tools", () => {
  let root: string;
  let inventory: Inventory;

  beforeAll(async () => {
    ({ root, inventory } = await project({
      "src/files.ts": `import { promises as fs } from "node:fs";

export async function store(path: string, body: string) {
  await fs.writeFile(path, body);
}
`,
      "src/tools.ts": `import { tool } from "ai";
import { exec } from "child_process";
import { z } from "zod";
import { store } from "./files.js";

export const run = tool({
  description: "Run a command later",
  inputSchema: z.object({ command: z.string() }),
  execute: async ({ command }) => {
    setTimeout(() => exec(command), 10);
    await store("/tmp/last-command", command);
  },
});
`,
    }));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("includes callbacks nested in the handler and helpers in other modules", () => {
    const run = inventory.tools.find((candidate) => candidate.name === "run");
    expect(summary(run?.capabilities ?? [])).toEqual([
      "process child_process#exec [command:param]",
      // The written path is a constant; only the content comes from the model.
      "file_write node:fs#promises.writeFile []",
    ]);
    expect(run?.capabilities[1]?.location.path).toBe("src/files.ts");
  });
});

describe("calls a handler's trace cannot follow", () => {
  const chain = Array.from(
    { length: 7 },
    (_, index) => `def step${index}(c):\n    return step${index + 1}(c)\n`,
  ).join("\n");
  const source = `import subprocess
from langchain_core.tools import tool

HANDLERS = {"run": subprocess.run}

${chain}
def step7(c):
    return subprocess.run(c, shell=True)


@tool
def deep(command: str) -> str:
    """Run a command several helpers down."""
    return step0(command)


@tool
def dispatch(command: str, on_done=None) -> str:
    """Run a command through a handler table."""
    HANDLERS["run"](command)
    getattr(subprocess, "run")(command)
    on_done(command)
    return "ok"


@tool
def notify(command: str, callback=None) -> str:
    """Run a command and report it."""
    result = subprocess.run(command, shell=True)
    callback(result)
    return "ok"


@tool
def plain(command: str) -> str:
    """Run a command."""
    return subprocess.run(command, shell=True)
`;
  const lineOf = (text: string) => source.split("\n").indexOf(text) + 1;
  let root: string;
  let result: Awaited<ReturnType<typeof scan>>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "plenger-capabilities-"));
    await writeFile(join(root, "tools.py"), source);
    result = await scan(root);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const tool = (name: string) => result.inventory.tools.find((item) => item.name === name);

  it("records a call past the depth limit and leaves it out of the capabilities", () => {
    expect(tool("deep")?.capabilities).toEqual([]);
    expect(tool("deep")?.trace).toMatchObject({ depthLimited: 1, dynamic: 0 });
    // step0 is depth 1, so step5 reaches the limit and its call to step6 is not followed.
    expect(tool("deep")?.trace?.locations).toEqual([
      expect.objectContaining({ line: lineOf("    return step6(c)") }),
    ]);
  });

  it("follows a fixed handler table, and records calls through a call result and a callback parameter", () => {
    expect(summary(tool("dispatch")?.capabilities ?? [])).toEqual([
      "process subprocess.run [command:param]",
    ]);
    expect(tool("dispatch")?.capabilities[0]?.location.line).toBe(
      lineOf('    HANDLERS["run"](command)'),
    );
    expect(tool("dispatch")?.trace).toMatchObject({ depthLimited: 0, dynamic: 2 });
    expect(tool("dispatch")?.trace?.locations.map((location) => location.line)).toEqual([
      lineOf('    getattr(subprocess, "run")(command)'),
      lineOf("    on_done(command)"),
    ]);
  });

  it("notes the calls on findings about the tool, and nothing for a complete trace", () => {
    expect(tool("plain")?.trace).toBeUndefined();
    const notes = (name: string) =>
      result.findings.find((finding) => finding.subject.name === name)?.notes ?? [];
    expect(notes("notify")).toContain(
      `Trace incomplete: 1 call through a callback, subscript or call result not followed (tools.py:${lineOf("    callback(result)")}). Effects behind them were not seen.`,
    );
    expect(notes("plain").some((note) => note.startsWith("Trace incomplete"))).toBe(false);
  });
});

describe("guards that limit a tool's input to fixed values", () => {
  let root: string;
  let inventory: Inventory;
  const inputs = (name: string) =>
    summary(inventory.tools.find((candidate) => candidate.name === name)?.capabilities ?? []);

  beforeAll(async () => {
    ({ root, inventory } = await project({
      "tools.py": `import os
import subprocess
from pathlib import Path

from langchain_core.tools import tool

NOTES = os.path.realpath("notes")
REPORTS = ("daily", "weekly")
GROWING = {"daily"}
EMPTY = set()
COMMANDS = {"disk": ["df", "-h"]}


def checked(name):
    if name not in REPORTS:
        raise ValueError(name)


def write_report(name, body):
    Path(f"/srv/{name}.md").write_text(body)


@tool
def exits(name: str, body: str) -> str:
    """Write a fixed report."""
    if name not in REPORTS:
        raise ValueError(name)
    Path(f"/srv/{name}.md").write_text(body)
    return "ok"


@tool
def inside(name: str, body: str) -> str:
    """Write a fixed report."""
    if name in REPORTS:
        write_report(name, body)
    return "ok"


@tool
def reassigned(name: str, body: str) -> str:
    """Write a report after renaming it."""
    if name not in REPORTS:
        raise ValueError(name)
    name = body
    Path(f"/srv/{name}.md").write_text(body)
    return "ok"


@tool
def elsewhere(name: str, body: str) -> str:
    """Write a report checked by a helper that does not stop the tool."""
    checked(name)
    Path(f"/srv/{name}.md").write_text(body)
    return "ok"


@tool
def growing(name: str, body: str) -> str:
    """Write a report from a set the code extends."""
    if name not in GROWING:
        raise ValueError(name)
    Path(f"/srv/{name}.md").write_text(body)
    return "ok"


@tool
def empty(name: str, body: str) -> str:
    """Write a report from a set filled at run time."""
    if name not in EMPTY:
        raise ValueError(name)
    Path(f"/srv/{name}.md").write_text(body)
    return "ok"


@tool
def lookup(kind: str) -> str:
    """Run a fixed command."""
    return subprocess.run(COMMANDS[kind], capture_output=True).stdout


@tool
def bare_prefix(name: str) -> str:
    """Read a note under a prefix check that a sibling directory passes."""
    path = os.path.realpath(os.path.join(NOTES, name))
    if not path.startswith(NOTES):
        raise ValueError(name)
    return open(path).read()


@tool
def separated_prefix(name: str) -> str:
    """Read a note under a prefix check that ends with a separator."""
    path = os.path.realpath(os.path.join(NOTES, name))
    if not path.startswith(NOTES + os.sep):
        raise ValueError(name)
    return open(path).read()


@tool
def relative_to(name: str) -> str:
    """Read a note inside the notes directory."""
    path = Path(os.path.realpath(os.path.join(NOTES, name)))
    if not path.is_relative_to(NOTES):
        raise ValueError(name)
    return open(path).read()


def register(name):
    GROWING.add(name)
`,
      "fetch.ts": `import { tool } from "ai";
import { z } from "zod";

const HOSTS = new Set(["docs.example.com"]);

export const allowed = tool({
  description: "Fetch a documentation page",
  inputSchema: z.object({ link: z.string() }),
  execute: async ({ link }) => {
    const url = new URL(link);
    if (!HOSTS.has(url.hostname)) throw new Error("host not allowed");
    return (await fetch(url)).text();
  },
});

export const unchecked = tool({
  description: "Fetch any page",
  inputSchema: z.object({ link: z.string() }),
  execute: async ({ link }) => {
    const url = new URL(link);
    if (!HOSTS.has(url.pathname)) throw new Error("path not allowed");
    return (await fetch(url)).text();
  },
});
`,
    }));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("drops input the guard limits, in the rest of the block or inside the body", () => {
    expect(inputs("exits")).toEqual(["file_write pathlib.Path().write_text []"]);
    expect(inputs("inside")).toEqual(["file_write pathlib.Path().write_text []"]);
    expect(inputs("lookup")).toEqual(["process subprocess.run []"]);
  });

  it("keeps input reassigned after the guard, checked in another function, or checked against a changing or empty set", () => {
    for (const name of ["reassigned", "elsewhere", "growing", "empty"])
      expect(inputs(name), name).not.toEqual(["file_write pathlib.Path().write_text []"]);
    expect(inputs("elsewhere")).toEqual(["file_write pathlib.Path().write_text [name:param]"]);
  });

  it("takes a resolved path as confined only behind a separator or is_relative_to", () => {
    expect(inputs("bare_prefix")).toEqual(["file_read open [path:name]"]);
    expect(inputs("separated_prefix")).toEqual(["file_read open []"]);
    expect(inputs("relative_to")).toEqual(["file_read open []"]);
  });

  it("treats a host allowlist as fixing the URL's host, and only the host", () => {
    const network = (name: string) =>
      inventory.tools
        .find((candidate) => candidate.name === name)
        ?.capabilities.find((item) => item.kind === "network");
    // The checked URL keeps the `URL` call it is built from, for output tracing, but no longer comes from `link`.
    expect(network("allowed")?.host).toEqual([expect.objectContaining({ text: "url" })]);
    expect(network("allowed")?.host?.[0]?.from).toBeUndefined();
    expect(network("unchecked")?.host?.map((part) => [part.text, part.from])).toEqual([
      ["url", ["link"]],
    ]);
  });
});

describe("calls through a fixed table of functions", () => {
  let root: string;
  let result: Awaited<ReturnType<typeof scan>>;
  const tool = (name: string) => result.inventory.tools.find((item) => item.name === name);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "plenger-capabilities-"));
    await writeFile(
      join(root, "tools.py"),
      `import os
import subprocess

from langchain_core.tools import tool


def run_shell(command):
    return subprocess.run(command, shell=True)


def remove(path):
    os.remove(path)


ACTIONS = {"shell": run_shell, "remove": remove}
LATER = {}


def register(name, handler):
    LATER[name] = handler


@tool
def act(action: str, argument: str) -> str:
    """Run one of the fixed actions."""
    return ACTIONS[action](argument)


@tool
def act_by_get(action: str, argument: str) -> str:
    """Run one of the fixed actions."""
    handler = ACTIONS.get(action)
    return handler(argument)


@tool
def remove_only(argument: str) -> str:
    """Run the fixed remove action."""
    return ACTIONS["remove"](argument)


@tool
def registered(action: str, argument: str) -> str:
    """Run an action registered at run time."""
    return LATER[action](argument)
`,
    );
    await writeFile(
      join(root, "tools.ts"),
      `import { exec } from "node:child_process";
import { tool } from "ai";
import { z } from "zod";

function runShell(command: string) {
  exec(command);
}

const HANDLERS = { shell: runShell };
const BY_NAME = new Map([["shell", runShell]]);

export const viaObject = tool({
  description: "Run a fixed handler",
  inputSchema: z.object({ command: z.string() }),
  execute: async ({ command }) => HANDLERS.shell(command),
});

export const viaMap = tool({
  description: "Run a fixed handler",
  inputSchema: z.object({ name: z.string(), command: z.string() }),
  execute: async ({ name, command }) => {
    const handler = BY_NAME.get(name);
    return handler(command);
  },
});
`,
    );
    result = await scan(root);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("follows every function a fixed dict holds, by subscript or .get", () => {
    for (const name of ["act", "act_by_get"])
      expect(summary(tool(name)?.capabilities ?? []), name).toEqual([
        "process subprocess.run [argument:param]",
        "file_delete os.remove [argument:param]",
      ]);
    expect(tool("act")?.trace).toBeUndefined();
  });

  it("follows only the entry a fixed key names", () => {
    expect(summary(tool("remove_only")?.capabilities ?? [])).toEqual([
      "file_delete os.remove [argument:param]",
    ]);
  });

  it("leaves a table the code fills at run time as a trace gap", () => {
    expect(tool("registered")?.capabilities).toEqual([]);
    expect(tool("registered")?.trace).toMatchObject({ dynamic: 1 });
  });

  it("follows object members and Map entries in JavaScript", () => {
    for (const name of ["viaObject", "viaMap"])
      expect(summary(tool(name)?.capabilities ?? []), name).toEqual([
        "process node:child_process#exec [command:param]",
      ]);
  });
});

describe("pathlib paths built with the division operator", () => {
  let root: string;
  let inventory: Inventory;
  const inputs = (name: string) =>
    summary(inventory.tools.find((candidate) => candidate.name === name)?.capabilities ?? []);

  beforeAll(async () => {
    ({ root, inventory } = await project({
      "tools.py": `from pathlib import Path

from langchain_core.tools import tool

NOTES = Path("notes").resolve()


@tool
def joined(name: str) -> str:
    """Read a note."""
    target = NOTES / name
    return target.read_text()


@tool
def inline(name: str) -> str:
    """Read a note."""
    return (NOTES / name).read_text()


@tool
def confined(name: str) -> str:
    """Read a note inside the notes directory."""
    target = (NOTES / name).resolve()
    if not target.is_relative_to(NOTES):
        raise ValueError(name)
    return target.read_text()
`,
    }));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("sees reads through a joined variable or a parenthesized join, and their input", () => {
    expect(inputs("joined")).toEqual([
      "file_read pathlib.Path().resolve().read_text [NOTES / name:other]",
    ]);
    expect(inputs("inline")).toEqual([
      "file_read pathlib.Path().resolve().read_text [NOTES / name:other]",
    ]);
  });

  it("applies a guard on the joined variable", () => {
    expect(inputs("confined")).toEqual([
      "file_read pathlib.Path().resolve().resolve().read_text []",
    ]);
  });
});

describe("tool classes on a base the project defines", () => {
  let root: string;
  let inventory: Inventory;
  const tool = (name: string) => inventory.tools.find((candidate) => candidate.name === name);

  beforeAll(async () => {
    ({ root, inventory } = await project({
      "framework/base.py": `from abc import ABC, abstractmethod


class BaseTool(ABC):
    name: str = ""
    description: str = ""

    @abstractmethod
    def _execute(self, *args):
        ...


class BaseFileTool(BaseTool):
    root: str = "/srv"


class Helper:
    def run(self, path):
        return open(path).read()
`,
      "tools/files.py": `from framework.base import BaseFileTool, BaseTool, Helper


class DeleteFile(BaseFileTool):
    name = "Delete File"
    description = "Delete a file"

    def _execute(self, file_name: str):
        import os

        os.remove(file_name)


class Abstract(BaseTool):
    name = "Not a tool yet"


class NotATool(Helper):
    def run(self, path):
        return open(path).read()
`,
    }));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds a subclass that implements the run method, through an intermediate base", () => {
    expect(tool("Delete File")).toMatchObject({
      framework: "project-tools",
      via: "class",
      params: ["file_name"],
      description: "Delete a file",
    });
    expect(summary(tool("Delete File")?.capabilities ?? [])).toEqual([
      "file_delete os.remove [file_name:param]",
    ]);
  });

  it("leaves out the abstract bases, a subclass without the method and classes on other bases", () => {
    expect(inventory.tools.map((item) => item.name).sort()).toEqual(["Delete File"]);
  });
});
