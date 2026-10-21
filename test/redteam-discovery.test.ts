import { access, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverProject, formatDiscovery } from "../src/redteam/discover.ts";
import { fixturePath } from "./support/fixtures.ts";
import { temporaryDir } from "./support/tmp.ts";

async function project(files: Record<string, string>) {
  const root = await temporaryDir("plenger-discovery-");
  for (const [name, contents] of Object.entries(files)) await writeFile(join(root, name), contents);
  return root;
}

const simple = `from llmfy import LLMfy, OpenAIChatModel
model = OpenAIChatModel(model="gpt-4o-mini")
agent = LLMfy(model)
def chat(message: str):
    return agent.chat(message).result.content
`;

describe("offline red-team discovery", () => {
  it("finds a directly returned factory and the async function that invokes it", async () => {
    const report = await discoverProject(fixturePath("redteam/llmfy"));
    expect(report).toMatchObject({
      kind: "redteam-discovery",
      schemaVersion: 1,
      mode: "offline",
      executionReady: false,
    });
    expect(
      report.targets.map((target) => [target.symbol, target.kind, target.status, target.async]),
    ).toEqual([
      ["build_agent", "factory", "candidate", false],
      ["chat", "function", "candidate", true],
    ]);
    expect(report.targets[0]?.agentIds).toEqual(report.targets[1]?.agentIds);
    expect(report.targets[1]?.parameters).toEqual(["message"]);
    expect(report.manifests).toContainEqual({ path: "requirements.txt", status: "present" });
    expect(formatDiscovery(report)).toContain("dynamic execution is not available yet");
  });

  it("retains unsupported context and nested functions alongside a FlowEngine factory", async () => {
    const report = await discoverProject(fixturePath("frameworks/python/llmfy_agent.py"));
    expect(report.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          symbol: "answer_with_context",
          status: "unsupported",
          reasons: ["input-mapping-required"],
        }),
        expect.objectContaining({
          symbol: "main_orchestrator",
          status: "unsupported",
          reasons: expect.arrayContaining(["not-a-module-function"]),
        }),
        expect.objectContaining({ symbol: "build_agent", kind: "factory", status: "candidate" }),
        expect.objectContaining({ symbol: "chat", kind: "function", status: "candidate" }),
      ]),
    );
  });

  it("never imports project code or reads the content of dependency manifests", async () => {
    const root = await project({});
    const marker = join(root, "IMPORTED");
    await writeFile(
      join(root, "agent.py"),
      `from pathlib import Path\nPath(${JSON.stringify(marker)}).touch()\nraise RuntimeError("must not import")\n${simple}`,
    );
    await writeFile(
      join(root, "pyproject.toml"),
      "invalid TOML with package scripts and credentials",
    );
    await writeFile(join(root, ".env"), "PLENGER_DISCOVERY_SENTINEL=must-not-appear");
    const report = await discoverProject(root);
    expect(report.targets).toHaveLength(1);
    expect(report.manifests).toContainEqual({ path: "pyproject.toml", status: "present" });
    expect(JSON.stringify(report)).not.toContain("must-not-appear");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recognises invocations linked across project files", async () => {
    const root = await project({
      "agent.py": simple.split("def chat")[0] as string,
      "main.py":
        "from agent import agent\nasync def ask(message):\n    return agent.chat(message).result.content\n",
    });
    const report = await discoverProject(root);
    expect(report.targets).toEqual([
      expect.objectContaining({
        symbol: "ask",
        kind: "function",
        location: expect.objectContaining({ path: "main.py" }),
        status: "candidate",
      }),
    ]);
  });

  it("does not mistake a model response for an agent factory", async () => {
    const root = await project({ "agent.py": simple });
    const report = await discoverProject(root);
    expect(report.targets.map((target) => target.kind)).toEqual(["function"]);
  });

  it("retains a syntax gap from any agent reached by the same entry point", async () => {
    const root = await project({
      "a.py": simple.split("def chat")[0] as string,
      "b.py": `${simple.split("def chat")[0]}broken =\n`,
      "main.py":
        "from a import agent as first\nfrom b import agent as second\ndef chat(message):\n    first.chat(message)\n    return second.chat(message)\n",
    });
    const report = await discoverProject(root);
    expect(report.targets).toHaveLength(1);
    expect(report.targets[0]).toMatchObject({
      symbol: "chat",
      status: "unsupported",
      reasons: ["agent-has-syntax-errors"],
    });
    expect(report.targets[0]?.agentIds).toHaveLength(2);
  });

  it("marks factories with competing return values and runtime arguments unsupported", async () => {
    const root = await project({
      "agent.py": `${simple.split("def chat")[0]}
def choose_agent(enabled):
    if enabled:
        return agent
    return None
`,
    });
    const report = await discoverProject(root);
    expect(report.targets).toEqual([
      expect.objectContaining({
        symbol: "choose_agent",
        kind: "factory",
        status: "unsupported",
        reasons: ["factory-needs-arguments", "ambiguous-factory-return"],
      }),
    ]);
  });

  it("keeps module-level invocations unresolved instead of inventing a callable", async () => {
    const root = await project({
      "agent.py": `${simple.split("def chat")[0]}agent.chat("hello")\n`,
    });
    const report = await discoverProject(root);
    expect(report.targets).toEqual([
      expect.objectContaining({
        kind: "unresolved",
        symbol: null,
        status: "unsupported",
        reasons: ["no-callable-entry-point"],
      }),
    ]);
  });

  it("does not treat decorators, methods or private functions as directly callable", async () => {
    const root = await project({
      "agent.py": `${simple.split("def chat")[0]}
@unknown_decorator
def decorated(message):
    return agent.chat(message)
def _private(message):
    return agent.chat(message)
class Service:
    def chat(self, message):
        return agent.chat(message)
`,
    });
    const report = await discoverProject(root);
    expect(report.targets).toHaveLength(3);
    expect(report.targets.every((target) => target.status === "unsupported")).toBe(true);
    expect(report.targets[0]?.reasons).toContain("decorated-function");
  });

  it("retains parser and file-limit gaps", async () => {
    const root = await project({ "a.py": `${simple}\nbroken =\n`, "b.py": simple });
    const report = await discoverProject(root, { maxFiles: 1 });
    expect(report.scan.truncated).toBe(true);
    expect(report.scan.syntaxErrors).toEqual(["a.py"]);
    expect(report.targets[0]?.reasons).toContain("source-has-syntax-errors");
    expect(formatDiscovery(report)).toContain("file limit was reached");
  });

  it("honours gitignore and reports manifest symlinks without following them", async () => {
    const root = await project({ "agent.py": simple, ".gitignore": "agent.py\n" });
    await symlink("nonexistent-outside-project", join(root, "requirements.txt"));
    await mkdir(join(root, "pyproject.toml"));
    const ignored = await discoverProject(root);
    expect(ignored.targets).toEqual([]);
    expect(ignored.scan.skipped).toContainEqual({ path: "agent.py", reason: "gitignored" });
    expect(ignored.manifests).toEqual(
      expect.arrayContaining([
        { path: "requirements.txt", status: "not-a-file" },
        { path: "pyproject.toml", status: "not-a-file" },
      ]),
    );
    expect((await discoverProject(root, { gitignore: false })).targets).toHaveLength(1);
  });

  it("produces deterministic reports and stable ids after relocation or added comments", async () => {
    const root = await project({ "agent.py": simple });
    const first = await discoverProject(root);
    expect(await discoverProject(root)).toEqual(first);
    const relocated = await project({ "agent.py": `# unrelated change\n${simple}` });
    const moved = await discoverProject(relocated);
    expect(moved.targets[0]?.id).toBe(first.targets[0]?.id);
    expect(moved.targets[0]?.location.line).toBe((first.targets[0]?.location.line ?? 0) + 1);
  });

  it("does not turn a project-local llmfy lookalike into a framework target", async () => {
    const root = await project({
      "llmfy.py": "class LLMfy:\n    def __init__(self, model): pass\n",
      "agent.py": simple,
    });
    expect((await discoverProject(root)).targets).toEqual([]);
  });
});

describe("file-canary pack binding", () => {
  it("binds through a tool that writes model-supplied content to a model-controlled path", async () => {
    const report = await discoverProject(fixturePath("redteam/llmfy"));
    for (const target of report.targets)
      expect(target.packs).toEqual([
        { profile: "llmfy-file-canary-v1", status: "bound", tools: ["save_note"], reasons: [] },
      ]);
    expect(formatDiscovery(report)).toContain("pack llmfy-file-canary-v1: bound via save_note");
  });

  const agent = (tool: string) => `from pathlib import Path
from llmfy import LLMfy, OpenAIChatModel, Tool
@Tool()
${tool}
def build_agent():
    agent = LLMfy(OpenAIChatModel(model="gpt-4o-mini"))
    agent.register_tool([act])
    return agent
`;
  it.each([
    ["no-file-write-tool", "def act(order_id: str) -> str:\n    return order_id"],
    [
      "file-content-not-written",
      "def act(name: str) -> str:\n    Path(name).mkdir()\n    return name",
    ],
    [
      "file-path-not-model-controlled",
      'def act(text: str) -> str:\n    Path("/tmp/log.txt").write_text(text)\n    return text',
    ],
    [
      "async-tool-handler",
      "async def act(path: str, text: str) -> str:\n    Path(path).write_text(text)\n    return text",
    ],
  ])("reports %s instead of binding by tool name", async (reason, tool) => {
    const root = await project({ "agent.py": agent(tool) });
    const report = await discoverProject(root);
    expect(report.targets).toHaveLength(1);
    expect(report.targets[0]?.status).toBe("candidate");
    expect(report.targets[0]?.packs).toEqual([
      { profile: "llmfy-file-canary-v1", status: "unbound", tools: [], reasons: [reason] },
    ]);
    expect(formatDiscovery(report)).toContain(`pack llmfy-file-canary-v1: unbound (${reason})`);
  });
});
