import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Io, main, VERSION } from "../src/cli/index.ts";
import { fixturePath } from "./support/fixtures.ts";

const fixture = fixturePath("mixed-agent");

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
    expect(result.schemaVersion).toBe(1);
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

describe("agent inventory output", () => {
  const corpus = fixturePath("frameworks");

  it("summarises the inventory after the files", async () => {
    const { code, stdout } = await run("scan", corpus);
    expect(code).toBe(0);
    expect(stdout).toContain("Agent inventory");
    expect(stdout).toMatch(/MCP servers\s+2\s+shell \(stdio\): 2 tools, files \(stdio\): 2 tools/);
    expect(stdout).toMatch(/Entry points\s+6/);
    expect(stdout).toContain("Not understood yet: @huggingface (1 file), dspy (1 file)");
  });

  it("says so when a project has no AI code", async () => {
    const { stdout } = await run("scan", join(fixture, "web/Chat.tsx"));
    expect(stdout).toContain("No LLM, agent, tool or MCP usage found.");
  });

  it("includes the full inventory in JSON", async () => {
    const result = JSON.parse((await run("scan", corpus, "--json")).stdout);
    expect(result.inventory.tools).toHaveLength(34);
    expect(result.files[0].facts).toBeUndefined();
  });
});

describe("findings output", () => {
  const risks = fixturePath("risks");

  it("lists the most urgent findings with their place and source line", async () => {
    const { code, stdout } = await run("scan", risks);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Findings {2}\d+ critical · \d+ high · \d+ medium · \d+ low/);
    expect(stdout).toContain(
      "CRITICAL 100  `POST /ops` passes request input to agent `ops_agent`, which can run commands",
    );
    expect(stdout).toContain("python/web_agents.py:16  PLG301 · high confidence · exposed");
    expect(stdout).toMatch(/… 45 more findings; use --all/);
    expect((await run("scan", risks, "--all")).stdout).not.toContain("more findings");
  });

  it("says that nothing found is not proof of absence", async () => {
    const { stdout } = await run("scan", join(fixture, "web/Chat.tsx"));
    expect(stdout).toContain(
      "No risks detected by plenger's rules. This is not proof that there are none.",
    );
  });

  it("includes findings and the rules they come from in JSON", async () => {
    const result = JSON.parse((await run("scan", risks, "--json")).stdout);
    expect(result.findings.length).toBeGreaterThan(50);
    const [first] = result.findings;
    expect(first).toMatchObject({ rule: expect.stringMatching(/^PLG\d{3}$/), score: 100 });
    expect(first.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const fired = new Set(result.findings.map((finding: { rule: string }) => finding.rule));
    expect(result.rules.map((rule: { id: string }) => rule.id).sort()).toEqual([...fired].sort());
  });
});

describe("plenger rules", () => {
  it("lists every rule with its OWASP and CWE mapping", async () => {
    const { code, stdout } = await run("rules");
    expect(code).toBe(0);
    expect(stdout).toContain("PLG101  critical  tool-command-injection");
    expect(stdout).toContain("LLM06:2025, LLM05:2025, ASI02, ASI05, CWE-78, CWE-77");
    const json = JSON.parse((await run("rules", "--json")).stdout);
    expect(json.rules.length).toBeGreaterThanOrEqual(20);
  });

  it("takes no path", async () => {
    expect(await run("rules", ".")).toMatchObject({ code: 2 });
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

  it.each([
    [["redteam", "--help"], "plenger redteam discover [path]"],
    [["redteam", "run", "--help"], "--provider <name|id>"],
    [["redteam", "compare", "--help"], "--change <text>"],
    [["redteam", "compare", "before.json", "-h"], "--change <text>"],
  ])("prints the most specific usage for %j", async (argv, expected) => {
    const result = await run(...argv);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(expected);
  });

  it("rejects unknown commands and options", async () => {
    expect(await run("attack")).toMatchObject({ code: 2 });
    expect((await run("attack")).stderr).toContain("unknown command 'attack'");
    expect(await run("scan", "--fast")).toMatchObject({ code: 2 });
  });
});

describe("plenger serve arguments", () => {
  it("describes the local dashboard and its shutdown command", async () => {
    const result = await run("serve", "--help");
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("plenger serve [path]");
    expect(result.stdout).toContain("127.0.0.1");
    expect(result.stdout).toContain("Ctrl+C");
    expect((await run("--help")).stdout).toContain("plenger serve");
  });

  it.each(["-1", "65536", "1.5", "NaN", ""])("rejects port %j", async (port) => {
    const result = await run("serve", `--port=${port}`);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--port must be an integer between 0 and 65535");
  });

  it("rejects an ambiguous or empty project folder", async () => {
    expect(await run("serve", ".", "--workspace", ".")).toMatchObject({ code: 2 });
    expect(await run("serve", "--workspace", "")).toMatchObject({ code: 2 });
    expect(await run("serve", ".", "other")).toMatchObject({ code: 2 });
  });

  it.each(["--json", "--no-gitignore", "--all"])(
    "rejects scan option %s instead of ignoring it",
    async (option) => {
      const result = await run("serve", option);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("is not supported by serve");
    },
  );

  it("limits dashboard options to serve", async () => {
    expect(await run("scan", fixture, "--port", "0")).toMatchObject({ code: 2 });
    expect(await run("rules", "--workspace", ".")).toMatchObject({ code: 2 });
  });
});
