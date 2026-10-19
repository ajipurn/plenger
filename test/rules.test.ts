import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rulesMarkdown } from "../src/report/rule-list.ts";
import { packageSpec } from "../src/rules/checks/mcp.ts";
import { RULES, triageScore } from "../src/rules/index.ts";
import { scan } from "../src/scan.ts";
import { findSecret, redact, redactKnown, secretIn } from "../src/shared/secrets.ts";
import { compactFindings } from "./support/compact.ts";
import { CORPORA } from "./support/corpora.ts";
import { fixturePath } from "./support/fixtures.ts";
import { temporaryDir } from "./support/tmp.ts";

describe.each(CORPORA)("findings on the %s corpus", (corpus) => {
  it("are exactly the reviewed ones", async () => {
    const expected: string[] = JSON.parse(
      await readFile(fixturePath(`${corpus}/expected-findings.json`), "utf8"),
    );
    const actual = compactFindings((await scan(fixturePath(corpus))).findings);
    expect([...actual].sort()).toEqual([...expected].sort());
  });
});

describe("rule catalog", () => {
  it("has a positive fixture for every rule", async () => {
    const findings: string[] = JSON.parse(
      await readFile(fixturePath("risks/expected-findings.json"), "utf8"),
    );
    const covered = new Set(findings.map((finding) => finding.split(" ")[0]));
    expect(RULES.filter((rule) => !covered.has(rule.id)).map((rule) => rule.id)).toEqual([]);
  });

  it("has unique ids, OWASP references and a remediation for every rule", () => {
    expect(new Set(RULES.map((rule) => rule.id)).size).toBe(RULES.length);
    expect(new Set(RULES.map((rule) => rule.name)).size).toBe(RULES.length);
    for (const rule of RULES) {
      expect(rule.id).toMatch(/^PLG\d{3}$/);
      expect(rule.name).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
      // Web route rules (PLG8xx) cover application code, not an OWASP LLM or agentic risk.
      if (!rule.id.startsWith("PLG8")) expect(rule.owasp.length, rule.id).toBeGreaterThan(0);
      for (const id of rule.owasp)
        expect(id).toMatch(/^(?:LLM(?:0[1-9]|10):2025|ASI(?:0[1-9]|10))$/);
      expect(rule.remediation.length).toBeGreaterThan(20);
    }
  });
});

describe("findings", () => {
  const project = async (files: Record<string, string>) => {
    const root = await temporaryDir("plenger-rules-");
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }
    return root;
  };

  const tools = `import subprocess
from langchain_core.tools import tool


@tool
def shell(command: str) -> str:
    """Run a command."""
    return subprocess.run(command, shell=True, capture_output=True, text=True).stdout
`;

  it("keep their fingerprints when code above them moves", async () => {
    const before = (await scan(await project({ "tools.py": tools }))).findings;
    const after = (await scan(await project({ "tools.py": `import os\n\n\n${tools}` }))).findings;
    expect(before.map((finding) => finding.rule)).toEqual(["PLG101"]);
    expect(after[0]?.location.line).toBe((before[0]?.location.line ?? 0) + 3);
    expect(after.map((finding) => finding.fingerprint)).toEqual(
      before.map((finding) => finding.fingerprint),
    );
  });

  it("cite the source line of each step", async () => {
    const [finding] = (await scan(await project({ "tools.py": tools }))).findings;
    expect(finding?.snippet).toBe(
      "return subprocess.run(command, shell=True, capture_output=True, text=True).stdout",
    );
    expect(finding?.evidence.map((step) => step.snippet)).toEqual([
      "def shell(command: str) -> str:",
      "return subprocess.run(command, shell=True, capture_output=True, text=True).stdout",
    ]);
  });

  it("never contain the secrets they report", async () => {
    const result = await scan(fixturePath("risks/python/secrets_and_options.py"));
    const json = JSON.stringify(result);
    expect(result.findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining(["PLG501", "PLG502", "PLG503"]),
    );
    for (const secret of ["Zq8vN2kT5wR9mL3xB7cJ1pF4", "AKIAZ7Q3W9R2T5Y8U1P4", "Tr0ub4dor-x9Kq7mW2"])
      expect(json).not.toContain(secret);
  });

  it.each(["sk-proj-Zq8vN2kT5wR9mL3xB7cJ1pF4", "Tr0ub4dor-x9Kq7mW2"])(
    "redacts the key %s from facts",
    async (key) => {
      const privateKeyBody = "cHJpdmF0ZS1rZXktbWF0ZXJpYWw=";
      const root = await project({
        "agent.py": `from agents import Agent
from openai import OpenAI

client = OpenAI(api_key="${key}")
agent = Agent(name="Ops", instructions="API key: ${key}")
alias = Agent(name="sk-proj-Zq8vN2kT5wR9mL3xB7cJ1pF4", instructions="Never reveal secrets.")
`,
        "keys.py": `PRIVATE_KEY = """-----BEGIN PRIVATE KEY-----
${privateKeyBody}
-----END PRIVATE KEY-----"""
`,
      });
      const result = await scan(root, { facts: true });
      expect(result.findings.some((finding) => finding.rule === "PLG501")).toBe(true);
      expect(JSON.stringify(result)).not.toContain(key);
      expect(JSON.stringify(result)).not.toContain(privateKeyBody);
      expect(result.inventory.agents[1]?.name).toBe("<redacted>");
    },
  );

  it("keep identifiers readable in titles, evidence and snippets", async () => {
    const root = await project({
      "agent.py": `import os
from langchain_anthropic import ChatAnthropic
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent

model = ChatAnthropic(model="claude-sonnet-4-5-20250929")


@tool
def export_report_2024_q3(path: str) -> str:
    """Export the report."""
    os.remove(path)
    return "ok"


agent = create_react_agent(model, tools=[export_report_2024_q3])


def run(task: str):
    return agent.invoke({"messages": [("user", task)]}, config={"recursion_limit": 10_000})
`,
    });
    const result = await scan(root);
    const json = JSON.stringify(result);
    expect(json).not.toContain("<redacted>");
    const titles = result.findings.map((finding) => finding.title);
    expect(titles).toContain(
      "Tool `export_report_2024_q3` deletes a file at a path chosen by the model",
    );
    const loop = result.findings.find((finding) => finding.rule === "PLG203");
    expect(loop?.evidence[0]?.message).toBe("`recursion_limit=10_000` removes the limit");
    expect(result.inventory.models[0]?.model).toBe("claude-sonnet-4-5-20250929");
    expect(loop?.snippet).toContain('config={"recursion_limit": 10_000}');
  });

  it("redact a literal API key of unknown format everywhere, without --facts too", async () => {
    const key = "3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c";
    const root = await project({
      "client.py": `from openai import OpenAI

client = OpenAI(api_key="${key}")
`,
    });
    const result = await scan(root);
    expect(result.findings.map((finding) => finding.rule)).toContain("PLG501");
    expect(JSON.stringify(result)).not.toContain(key);
    expect(result.findings[0]?.snippet).toBe('client = OpenAI(api_key="<redacted>")');
  });

  it.each(["None", "False", "{}"])("does not treat auth=%s as protection", async (auth) => {
    const root = await project({
      "server.py": `from mcp.server.fastmcp import FastMCP
import subprocess

mcp = FastMCP("ops", auth=${auth})

@mcp.tool()
def run(command: str):
    return subprocess.run(command, shell=True)

mcp.run(transport="streamable-http")
`,
    });
    expect((await scan(root)).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: "PLG601", exposed: true })]),
    );
  });

  it.each(["http://[::1]:8000/mcp", "http://user:pass@localhost:8000/mcp"])(
    "recognises the local MCP URL %s",
    async (url) => {
      const root = await project({
        "client.py": `from agents.mcp import MCPServerStreamableHttp
client = MCPServerStreamableHttp(params={"url": "${url}"})
`,
      });
      const result = await scan(root);
      expect(result.inventory.mcpClients).toHaveLength(1);
      expect(result.findings.some((finding) => finding.rule === "PLG603")).toBe(false);
    },
  );

  it.each(["[]", "None"])("does not treat interrupt_before=%s as approval", async (interrupts) => {
    const root = await project({
      "agent.py": `from langgraph.prebuilt import create_react_agent
from langchain_core.tools import tool
import subprocess

@tool
def run(command: str):
    """Run a command."""
    return subprocess.run(command, shell=True)

agent = create_react_agent("openai:gpt-4o", tools=[run], interrupt_before=${interrupts})
`,
    });
    expect((await scan(root)).findings.some((finding) => finding.rule === "PLG201")).toBe(true);
  });

  it("only attaches compile interrupts to the graph they belong to", async () => {
    const root = await project({
      "graphs.py": `from langgraph.graph import StateGraph
from langgraph.prebuilt import ToolNode
from langchain_core.tools import tool
import subprocess

@tool
def run(command: str):
    """Run a command."""
    return subprocess.run(command, shell=True)

unsafe = StateGraph(dict)
unsafe.add_node("tools", ToolNode([run]))
unsafe.compile()

approved = StateGraph(dict)
approved.add_node("tools", ToolNode([run]))
approved.compile(interrupt_before=["tools"])
`,
    });
    const result = await scan(root);
    expect(result.inventory.agents.map((agent) => agent.approval)).toEqual([
      undefined,
      "interrupt_before",
    ]);
    expect(result.findings.filter((finding) => finding.rule === "PLG201")).toHaveLength(1);
  });

  it.each(["subprocess.run(second.final_output, shell=True)", "run_command(second.final_output)"])(
    "traces a later agent run into %s",
    async (effect) => {
      const root = await project({
        "agent.py": `from agents import Agent, Runner
import subprocess
from helpers import run_command

agent = Agent(name="Planner", instructions="Plan the task.")

async def solve(task: str):
    first = await Runner.run(agent, "Say hello")
    print(first.final_output)
    second = await Runner.run(agent, task)
    return ${effect}
`,
        "helpers.py": `import subprocess

def run_command(command: str):
    return subprocess.run(command, shell=True)
`,
      });
      const findings = (await scan(root)).findings.filter((finding) => finding.rule === "PLG401");
      expect(findings).toHaveLength(1);
      expect(findings[0]?.evidence[0]?.location.line).toBe(10);
    },
  );

  it("follow request data through variables, members and calls", async () => {
    const root = await project({
      "app.py": `from fastapi import FastAPI, Request
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent
import subprocess

@tool
def run(command: str) -> str:
    """Run."""
    return subprocess.run(command, shell=True).stdout

agent = create_react_agent("openai:gpt-4o", tools=[run])
app = FastAPI()

@app.post("/chat")
async def chat(request: Request):
    body = await request.json()
    text = body.get("message") or ""
    return agent.invoke({"messages": [("user", text.strip())]})
`,
    });
    const [finding] = (await scan(root)).findings.filter((item) => item.rule === "PLG301");
    expect(finding).toMatchObject({ severity: "critical", confidence: "high", exposed: true });
  });

  it("follow request input into commands, paths and SQL, not dependencies or confined paths", async () => {
    const root = await project({
      "paths.py": `from pathlib import Path

BASE = Path("files").resolve()


def safe_join(base: Path, name: str) -> Path:
    path = (base / name).resolve()
    if not path.is_relative_to(base):
        raise ValueError("outside the base")
    return path


def user_file(name: str) -> Path:
    return safe_join(BASE, name)


def raw_file(name: str) -> Path:
    return BASE / name
`,
      "app.py": `import shutil
import subprocess
from typing import Annotated

from fastapi import Depends, FastAPI
from langchain_core.tools import tool

from paths import raw_file, user_file

app = FastAPI()


def folder() -> str:
    return "/srv/shared"


@app.get("/files/{name}")
def download(name: str):
    return open(user_file(name)).read()


@app.get("/raw/{name}")
def download_raw(name: str):
    return open(raw_file(name)).read()


@app.get("/shared")
def shared(base: Annotated[str, Depends(folder)]):
    return open(base + "/index.txt").read()


@app.get("/items/{item_id}")
def item(item_id: int):
    return open(f"/srv/items/{item_id}.json").read()


@app.get("/convert/{name}")
def convert(name: str):
    return subprocess.run([shutil.which("ffmpeg"), "-i", name]).returncode


@tool
def read_user_file(name: str) -> str:
    """Read a user file."""
    return open(user_file(name)).read()
`,
    });
    const findings = (await scan(root)).findings;
    expect(
      findings.map((finding) => `${finding.rule} ${finding.severity} ${finding.subject.name}`),
    ).toEqual(["PLG802 high GET /raw/{name}", "PLG801 medium GET /convert/{name}"]);
    expect(findings[0]?.notes).toContain("Request input traced: `name`.");
  });

  it("are not reported for a fixed host, a parameterised query or an approved tool", async () => {
    const root = await project({
      "tools.py": `import sqlite3
import subprocess
import requests
from agents import function_tool

DB = sqlite3.connect("app.db")

@function_tool
def weather(city: str) -> str:
    """Weather."""
    return requests.get(f"https://api.weather.example/v1?city={city}").text

@function_tool
def find(name: str) -> list:
    """Find."""
    return DB.execute("SELECT * FROM users WHERE name = ?", (name,)).fetchall()

@function_tool(needs_approval=True)
def deploy(service: str) -> str:
    """Deploy."""
    return subprocess.run(["deploy", service]).stdout
`,
    });
    const findings = (await scan(root)).findings;
    expect(findings.map((finding) => `${finding.rule} ${finding.confidence}`)).toEqual([
      "PLG102 low",
    ]);
  });
});

describe("triage score", () => {
  it("orders by severity, then confidence, and raises exposed findings", () => {
    expect(triageScore("critical", "high", false)).toBeGreaterThan(
      triageScore("high", "high", false),
    );
    expect(triageScore("high", "high", false)).toBeGreaterThan(
      triageScore("high", "medium", false),
    );
    expect(triageScore("high", "high", true)).toBeGreaterThan(triageScore("high", "high", false));
    expect(triageScore("critical", "high", true)).toBe(100);
  });
});

describe("MCP launcher commands", () => {
  it.each([
    [
      "npx -y @modelcontextprotocol/server-filesystem /srv",
      "@modelcontextprotocol/server-filesystem",
      false,
    ],
    [
      "npx -y @modelcontextprotocol/server-filesystem@2025.8.21 /srv",
      "@modelcontextprotocol/server-filesystem",
      true,
    ],
    ["npx -y mcp-remote@latest https://x", "mcp-remote", false],
    ["npx --package tavily-mcp@0.2.1 tavily-mcp", "tavily-mcp", true],
    ["pnpm dlx some-server@^1.2.0", "some-server", false],
    ["uvx mcp-server-git", "mcp-server-git", false],
    ["uvx mcp-server-git==0.6.2", "mcp-server-git", true],
    ["uvx --from mcp-server-fetch@0.6.3 mcp-server-fetch", "mcp-server-fetch", true],
    ["pipx run mcp-server-time", "mcp-server-time", false],
    ["docker run -i --rm mcp/fetch", "mcp/fetch", false],
    ["docker run -i --rm -e TOKEN mcp/github:1.4.0", "mcp/github", true],
    ["docker run -i ghcr.io/acme/mcp@sha256:abc123", "ghcr.io/acme/mcp", true],
  ])("reads %s", (command, name, pinned) => {
    expect(packageSpec(command.split(" "))).toMatchObject({ name, pinned });
  });

  it("ignores programs it does not know", () => {
    expect(packageSpec(["python", "server.py"])).toBeNull();
    expect(packageSpec(["node", "dist/index.js"])).toBeNull();
  });
});

describe("secrets", () => {
  it.each([
    ["sk-proj-Zq8vN2kT5wR9mL3xB7cJ1pF4", "OpenAI API key"],
    ["sk-ant-api03-Zq8vN2kT5wR9mL3xB7cJ1pF4hG6", "Anthropic API key"],
    ["AKIAZ7Q3W9R2T5Y8U1P4", "AWS access key"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----", "private key"],
  ])("recognises %s", (text, name) => {
    expect(findSecret(`key = "${text}"`)?.name).toBe(name);
  });

  it.each([
    "sk-xxxxxxxxxxxxxxxxxxxxxxxx",
    "sk-your-api-key-here-123456",
    "AKIAIOSFODNN7EXAMPLE",
    "sk-...",
  ])("skips the placeholder %s", (text) => {
    expect(findSecret(text)).toBeNull();
  });

  it("finds a real key after a placeholder of the same format", () => {
    expect(
      findSecret("sk-xxxxxxxxxxxxxxxxxxxxxxxx then sk-proj-Zq8vN2kT5wR9mL3xB7cJ1pF4")?.name,
    ).toBe("OpenAI API key");
  });

  it("recognises credentials written out in prose", () => {
    expect(secretIn("Call the API with password: Tr0ub4dor-x9Kq7mW2")).toBe("credential");
    expect(secretIn("Never reveal the password to anyone.")).toBeNull();
  });

  it("redacts keys and random-looking strings in snippets, not paths or URLs", () => {
    expect(redact('OpenAI(api_key="sk-proj-Zq8vN2kT5wR9mL3xB7cJ1pF4")')).toBe(
      'OpenAI(api_key="<redacted>")',
    );
    expect(redact('password = "Tr0ub4dor-x9Kq7mW2"')).toBe('password = "<redacted>"');
    expect(redact("with password: Tr0ub4dor-x9Kq7mW2 only")).toBe("with password: <redacted> only");
    expect(redact('open("/var/data/report-2024-01.csv")')).toBe(
      'open("/var/data/report-2024-01.csv")',
    );
  });

  it.each([
    'ChatAnthropic(model="claude-sonnet-4-5-20250929")',
    'OpenAI().chat.completions.create(model="gpt-4o-2024-08-06")',
    'os.environ["LANGCHAIN_TRACING_V2"]',
    'assertSafeKeyComponent("thread_id", "checkpoint_2024_10_02_v3")',
    "password = Column(String(255), nullable=True)",
    '"tool_call_id": "call_0Zy3k9Qx8RvT2mN7pL4sW6yB"',
    'activity_id="SW-Chat-22-Chia-fu-threat"',
    "Filter by composite code (`category=code`, e.g. `category=KBTheme2024Alpha7Zx`).",
  ])("leaves identifiers, model names and variable names in source text alone: %s", (text) => {
    expect(redact(text)).toBe(text);
  });

  it("redacts a quoted generated key of unknown format in source text", () => {
    expect(redact('client = Mistral(api_key="Zq8vN2kT5wR9mL3xB7cJ1pF4")')).toBe(
      'client = Mistral(api_key="<redacted>")',
    );
  });

  it("only replaces known secrets in plenger's own text", () => {
    const title = "Tool `export_report_2024_q3` reads `Zq8vN2kT5wR9mL3xB7cJ1pF4Aa`";
    expect(redactKnown(title)).toBe(title);
    expect(redactKnown("Reviewed sk-proj-Zq8vN2kT5wR9mL3xB7cJ1pF4")).toBe("Reviewed <redacted>");
    expect(redactKnown("id 3f9a8b7c6d5e4f3a", ["3f9a8b7c6d5e4f3a"])).toBe("id <redacted>");
  });

  it("redacts private key material, including truncated blocks", () => {
    const body = "cHJpdmF0ZS1rZXktbWF0ZXJpYWw=";
    const key = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    expect(redact(`prefix\n${key}\nsuffix`)).toBe("prefix\n<redacted>\nsuffix");
    expect(redact(`-----BEGIN PRIVATE KEY-----\n${body}`)).toBe("<redacted>");
  });
});

describe("rule reference", () => {
  it("is up to date with the catalog (run node scripts/rules-doc.ts)", async () => {
    const doc = await readFile(new URL("../docs/RULES.md", import.meta.url), "utf8");
    expect(doc).toBe(rulesMarkdown(RULES));
  });
});
