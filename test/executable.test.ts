import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { findExecutable, windowsPowerShell } from "../src/shared/executable.ts";
import { temporaryDir } from "./support/tmp.ts";

async function program(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, "#!/bin/sh\n");
  await chmod(path, 0o755);
  return path;
}

describe("findExecutable", () => {
  it("returns the program from the first absolute PATH entry and skips relative and empty ones", async () => {
    const root = await temporaryDir();
    const tools = join(root, "tools");
    await program(join(root, "bin"), "git");
    const git = await program(tools, "git");
    const PATH = ["bin", ".", "", tools].join(delimiter);
    expect(findExecutable("git", { PATH }, "linux")).toBe(git);
    expect(findExecutable("git", { PATH: ["bin", ".", ""].join(delimiter) }, "linux")).toBeNull();
  });

  it("on Windows takes only programs that run without a shell", async () => {
    const root = await temporaryDir();
    const scripts = join(root, "scripts");
    const tools = join(root, "tools");
    await program(scripts, "git.cmd");
    const git = await program(tools, "git.exe");
    expect(findExecutable("git", { Path: [scripts, tools].join(delimiter) }, "win32")).toBe(git);
    expect(findExecutable("git", { Path: scripts }, "win32")).toBeNull();
  });

  it("names Windows PowerShell under the system root", () => {
    expect(windowsPowerShell({ SystemRoot: "D:\\Windows" })).toBe(
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(windowsPowerShell({})).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });
});
