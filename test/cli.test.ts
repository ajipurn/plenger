import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type Io, main, VERSION } from "../src/cli.ts";

const fixture = fileURLToPath(new URL("fixtures/mixed-agent", import.meta.url));

async function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    color: false,
  };
  const code = await main(argv, io);
  return { code, stdout: out.join(""), stderr: err.join("") };
}

describe("plenger scan", () => {
  it("summarises the files it parsed and skipped", async () => {
    const { code, stdout, stderr } = await run("scan", fixture);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(`plenger ${VERSION}`);
    expect(stdout).toMatch(/Python\s+3 files/);
    expect(stdout).toMatch(/TypeScript\s+2 files/);
    expect(stdout).toMatch(/JavaScript\s+1 file\b/);
    expect(stdout).toContain("6 files parsed");
    expect(stdout).toContain("1 file with syntax errors");
    expect(stdout).toContain("app/broken.py");
    expect(stdout).toContain("3 files skipped: minified 2, type declarations 1");
  });

  it("emits the full result as JSON", async () => {
    const { code, stdout } = await run("scan", fixture, "--json");
    const result = JSON.parse(stdout);

    expect(code).toBe(0);
    expect(result.schemaVersion).toBe(0);
    expect(result.tool).toEqual({ name: "plenger", version: VERSION });
    expect(result.files.map((file: { path: string }) => file.path)).toEqual([
      "app/broken.py",
      "app/main.py",
      "app/tools.py",
      "web/Chat.tsx",
      "web/agent.ts",
      "web/legacy.cjs",
    ]);
    expect(result.files.find((file: { path: string }) => file.path === "app/main.py")).toEqual({
      path: "app/main.py",
      language: "python",
      bytes: 362,
      lines: 16,
      syntaxErrors: false,
    });
  });

  it("reports a missing path as an error", async () => {
    const { code, stderr } = await run("scan", "does/not/exist");
    expect(code).toBe(1);
    expect(stderr).toContain("no such file or directory");
  });
});

describe("plenger facts", () => {
  it("prints the facts of a single file as JSON", async () => {
    const { code, stdout } = await run("facts", join(fixture, "app/main.py"));
    const result = JSON.parse(stdout);

    expect(code).toBe(0);
    expect(result.files).toHaveLength(1);
    const [file] = result.files;
    expect(file.path).toBe("main.py");
    expect(
      file.facts.calls.map((call: { ref: { name: string } | null }) => call.ref?.name),
    ).toContain("openai.OpenAI().chat.completions.create");
  });
});

describe("--no-gitignore", () => {
  it("includes files that .gitignore leaves out", async () => {
    const root = await mkdtemp(join(tmpdir(), "plenger-cli-"));
    try {
      await writeFile(join(root, ".gitignore"), "generated.py\n");
      await writeFile(join(root, "generated.py"), "x = 1\n");
      await writeFile(join(root, "main.py"), "y = 2\n");

      expect((await run("scan", root)).stdout).toContain("1 file skipped: gitignored 1");
      expect((await run("scan", root, "--no-gitignore")).stdout).toMatch(/Python\s+2 files/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("command line", () => {
  it("prints the version", async () => {
    expect(await run("--version")).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: "" });
  });

  it("prints usage for --help and when no command is given", async () => {
    expect((await run("--help")).stdout).toContain("plenger scan");
    const bare = await run();
    expect(bare.code).toBe(2);
    expect(bare.stderr).toContain("Usage:");
  });

  it("rejects unknown commands and options", async () => {
    expect(await run("attack")).toMatchObject({ code: 2 });
    expect((await run("attack")).stderr).toContain("unknown command 'attack'");
    expect(await run("scan", "--fast")).toMatchObject({ code: 2 });
  });
});
