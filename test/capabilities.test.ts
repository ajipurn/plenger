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

  it("records calls through a subscript, a call result and a callback parameter", () => {
    expect(tool("dispatch")?.trace).toMatchObject({ depthLimited: 0, dynamic: 3 });
    expect(tool("dispatch")?.trace?.locations.map((location) => location.line)).toEqual([
      lineOf('    HANDLERS["run"](command)'),
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
