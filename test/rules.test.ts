import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCorpus } from "../scripts/lib/evaluation.ts";
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
    // Library rules fire only in library scans; their vulnerable corpus cases cover them.
    for (const item of await loadCorpus(fixturePath("evaluation-library")))
      if (item.kind === "vulnerable") for (const rule of item.static) covered.add(rule);
    expect(RULES.filter((rule) => !covered.has(rule.id)).map((rule) => rule.id)).toEqual([]);
  });

  it("has unique ids, OWASP references and a remediation for every rule", () => {
    expect(new Set(RULES.map((rule) => rule.id)).size).toBe(RULES.length);
    expect(new Set(RULES.map((rule) => rule.name)).size).toBe(RULES.length);
    for (const rule of RULES) {
      expect(rule.id).toMatch(/^PLG\d{3}$/);
      expect(rule.name).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
      // Web route (PLG8xx) and library (PLG9xx) rules cover application and package code,
      // not an OWASP LLM or agentic risk.
      if (!/^PLG[89]/.test(rule.id)) expect(rule.owasp.length, rule.id).toBeGreaterThan(0);
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

  it("read check helpers and what helpers return, across files", async () => {
    const root = await project({
      "helpers.py": `import os
from flask import request

BASE = os.path.realpath("files")


def is_within(base: str, path: str) -> bool:
    rel = os.path.relpath(os.path.realpath(path), base)
    return not rel.startswith("..") and not os.path.isabs(rel)


def loosely_within(base: str, path: str) -> bool:
    return os.path.realpath(path).startswith(base)


def label(kind: str, name: str) -> str:
    return f"report-{kind}.txt"


def requested_name() -> str:
    return request.args.get("name", "")
`,
      "app.py": `import os
import subprocess

from flask import Flask, request

from helpers import BASE, is_within, label, loosely_within, requested_name

app = Flask(__name__)


@app.get("/checked")
def checked():
    target = os.path.join(BASE, request.args["name"])
    if not is_within(BASE, target):
        return "no", 400
    return open(target).read()


@app.get("/loose")
def loose():
    target = os.path.join(BASE, request.args["name"])
    if not loosely_within(BASE, target):
        return "no", 400
    return open(target).read()


@app.get("/label")
def labelled():
    return open(os.path.join(BASE, label("daily", request.args["name"]))).read()


@app.get("/cat")
def cat():
    return subprocess.run(f"cat {requested_name()}", shell=True).stdout
`,
    });
    const findings = (await scan(root)).findings;
    expect(findings.map((finding) => `${finding.rule} ${finding.subject.name}`).sort()).toEqual([
      "PLG801 GET /cat",
      "PLG802 GET /loose",
    ]);
    expect(findings.find((finding) => finding.rule === "PLG801")?.notes).toContain(
      "Request input traced: `flask.request`.",
    );
  });

  it("bind unpacked parameters by key, and count only the handler's own parameters", async () => {
    const root = await project({
      "files.js": `const fs = require("fs");
const path = require("path");
const BASE = path.resolve("saved");
function save({ name, body }) {
  fs.writeFileSync(path.join(BASE, name), body);
}
module.exports = { save };
`,
      "server.js": `const express = require("express");
const { save } = require("./files.js");
const app = express();
app.post("/save", (req, res) => {
  save({ name: req.body.name, body: req.body.text });
  res.end();
});
app.post("/defaults", (req, res) => {
  save(loadDefaults());
  res.end();
});
`,
    });
    const findings = (await scan(root)).findings;
    expect(findings.map((finding) => `${finding.rule} ${finding.subject.name}`)).toEqual([
      "PLG802 POST /save",
    ]);
    expect(findings[0]?.notes).toContain("Request input traced: `req`.");
  });

  it("read file names stripped of separators, and absolute paths among arguments", async () => {
    const root = await project({
      "files.js": `const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const slugify = require("slugify");
const BASE = path.resolve("hot");
function sanitizeFileName(fileName) {
  if (!fileName) return fileName;
  return fileName.replace(/[<>:"/\\\\|?*]/g, "");
}
function normalizePath(filepath = "") {
  return path.normalize(filepath.trim()).replace(/^(\\.\\.(\\/|\\\\|$))+/, "");
}
function download(url) {
  const urlObj = new URL(url);
  const slug = slugify(urlObj.pathname, { lower: true });
  const filename = \`\${urlObj.hostname}-\${slug}\`;
  fs.writeFileSync(path.join(BASE, filename), "x");
}
function folder(author) {
  const out = sanitizeFileName(slugify(\`\${author} transcripts\`).toLowerCase());
  fs.mkdirSync(path.resolve(BASE, out), { recursive: true });
}
function convert(filename) {
  const input = normalizePath(path.resolve(BASE, filename));
  const output = path.resolve(BASE, \`\${path.parse(filename).name}.wav\`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  spawnSync("ffmpeg", ["-i", input, "-y", output]);
}
function unsafeBase(name) {
  fs.rmSync(path.join(BASE, path.basename(name), "cache"), { recursive: true });
}
function unsafeArg(flag) {
  spawnSync("ffmpeg", ["-i", flag]);
}
function checkedArg(name) {
  if (!/^[\\w-]+$/.test(name)) throw new Error("bad name");
  spawnSync("ffmpeg", ["-i", path.resolve(BASE, name)]);
}
module.exports = { download, folder, convert, unsafeBase, unsafeArg, checkedArg };
`,
      "server.js": `const express = require("express");
const { download, folder, convert, unsafeBase, unsafeArg, checkedArg } = require("./files.js");
const app = express();
app.post("/checked", (req, res) => { checkedArg(req.body.name); res.end(); });
app.post("/download", (req, res) => { download(req.body.url); res.end(); });
app.post("/folder", (req, res) => { folder(req.body.author); res.end(); });
app.post("/convert", (req, res) => { convert(req.body.filename); res.end(); });
app.post("/base", (req, res) => { unsafeBase(req.body.name); res.end(); });
app.post("/arg", (req, res) => { unsafeArg(req.body.flag); res.end(); });
`,
      "app.py": `import os
import re
from flask import Flask, request
from werkzeug.utils import secure_filename

app = Flask(__name__)
UPLOADS = os.path.realpath("uploads")


@app.post("/upload")
def upload():
    f = request.files["file"]
    f.save(os.path.join(UPLOADS, secure_filename(f.filename)))
    with open(os.path.join(UPLOADS, secure_filename(f.filename)), "wb") as out:
        out.write(b"")
    return "ok"


@app.post("/rename")
def rename():
    name = re.sub(r"[^\\w.-]", "_", request.form["name"])
    return open(os.path.join(UPLOADS, name)).read()


@app.post("/base")
def base():
    name = os.path.basename(request.form["name"])
    return open(os.path.join(UPLOADS, f"{name}.txt")).read()


@app.post("/raw")
def raw():
    name = os.path.basename(request.form["name"])
    return open(os.path.join(UPLOADS, name, "index.txt")).read()
`,
    });
    const findings = (await scan(root)).findings;
    // A name that may be \`..\` before another component, a raw argument and an absolute
    // path that leaves its folder (\`convert\`'s input) remain. A checked name resolved
    // inside the folder cannot be an option and stays there.
    expect(
      findings
        .map((finding) => `${finding.rule} ${finding.location.path} ${finding.subject.name}`)
        .sort(),
    ).toEqual([
      "PLG801 files.js POST /arg",
      "PLG801 files.js POST /convert",
      "PLG802 app.py POST /raw",
      "PLG802 files.js POST /base",
    ]);
  });

  it("report request input reaching a URL's host, code, templates, deserializers and ORM SQL", async () => {
    const root = await project({
      "app.py": `import pickle
import requests
from flask import Flask, request, render_template_string, render_template
from jinja2.sandbox import SandboxedEnvironment
from sqlalchemy import text
from django.db import connection

app = Flask(__name__)


@app.get("/proxy")
def proxy():
    return requests.get(request.args["url"]).text


@app.get("/fixed-host")
def fixed_host():
    return requests.get(f"https://api.example.com/items/{request.args['id']}").text


@app.post("/calc")
def calc():
    return str(eval(request.form["expr"]))


@app.get("/hello")
def hello():
    return render_template_string("Hello " + request.args["name"])


@app.get("/hello-safe")
def hello_safe():
    return render_template("hello.html", name=request.args["name"])


@app.get("/sandboxed")
def sandboxed():
    return SandboxedEnvironment().from_string(request.args["t"]).render()


@app.post("/load")
def load():
    return str(pickle.loads(request.data))


@app.get("/search")
def search():
    return str(text(f"SELECT * FROM items WHERE name = '{request.args['q']}'"))


@app.get("/django")
def django_search():
    with connection.cursor() as cursor:
        cursor.execute("SELECT * FROM items WHERE name = '%s'" % request.args["q"])
        return str(cursor.fetchall())
`,
      "server.js": `const express = require("express");
const ejs = require("ejs");
const { Sequelize } = require("sequelize");
const sequelize = new Sequelize(process.env.DATABASE_URL);
const app = express();
app.get("/fetch", async (req, res) => res.send(await (await fetch(req.query.url)).text()));
app.get("/page", (req, res) => res.send(ejs.render(req.query.template, {})));
app.get("/users", async (req, res) => res.json(await sequelize.query(\`SELECT * FROM users WHERE name = '\${req.query.name}'\`)));
app.get("/users-safe", async (req, res) => res.json(await sequelize.query("SELECT * FROM users WHERE name = ?", { replacements: [req.query.name] })));
`,
    });
    const findings = (await scan(root)).findings;
    // A fixed host, a template file, a sandboxed template and bound SQL values are not reported.
    expect(findings.map((finding) => `${finding.rule} ${finding.subject.name}`).sort()).toEqual([
      "PLG803 GET /django",
      "PLG803 GET /search",
      "PLG803 GET /users",
      "PLG804 GET /fetch",
      "PLG804 GET /proxy",
      "PLG805 POST /calc",
      "PLG806 GET /hello",
      "PLG806 GET /page",
      "PLG807 POST /load",
    ]);
  });

  it("read each component of a built path, and slugify's replacement", async () => {
    const root = await project({
      "server.js": `const fs = require("fs");
const slugify = require("slugify");
const express = require("express");
const app = express();
app.get("/a", (req, res) => res.send(fs.readFileSync(\`/srv/\${slugify(req.query.n)}.txt\`)));
app.get("/b", (req, res) => res.send(fs.readFileSync(\`/srv/\${slugify(req.query.n, "/")}.txt\`)));
app.get("/c", (req, res) => res.send(fs.readFileSync(\`/srv/\${slugify(req.query.n, { replacement: "/" })}.txt\`)));
`,
    });
    const findings = (await scan(root)).findings;
    // \`/srv/${slug}.txt\` keeps the slug in one component; a "/" replacement does not.
    expect(findings.map((finding) => `${finding.rule} ${finding.subject.name}`).sort()).toEqual([
      "PLG802 GET /b",
      "PLG802 GET /c",
    ]);
  });

  it("read werkzeug's safe_join and a suffix check before basename", async () => {
    const root = await project({
      "app.py": `import os

from flask import Flask, request
from werkzeug.security import safe_join

app = Flask(__name__)
BASE = os.path.realpath("files")


@app.get("/joined")
def joined():
    return open(safe_join(BASE, request.args["name"])).read()


@app.post("/delete")
def delete():
    name = request.form["name"]
    if not name.endswith(".json"):
        return "only JSON files", 400
    os.remove(os.path.join(BASE, os.path.basename(name)))
    return "ok"


@app.post("/delete-any")
def delete_any():
    os.remove(os.path.join(BASE, os.path.basename(request.form["name"])))
    return "ok"
`,
    });
    const findings = (await scan(root)).findings;
    // \`basename("..")\` is \`..\`: a delete of the base's parent stays reported.
    expect(findings.map((finding) => `${finding.rule} ${finding.subject.name}`)).toEqual([
      "PLG802 POST /delete-any",
    ]);
  });

  it("read torch.load with weights_only and the text members of a pathlib path as safe", async () => {
    const root = await project({
      "app.py": `import os
from pathlib import Path

import torch
from flask import Flask, request

app = Flask(__name__)
MODELS = os.path.realpath("models")


@app.post("/load")
def load():
    return str(torch.load(os.path.join(MODELS, request.form["name"])))


@app.post("/weights")
def weights():
    return str(torch.load(os.path.join(MODELS, request.form["name"]), weights_only=True))


@app.post("/format")
def format_of():
    return Path(request.form["name"]).suffix.replace(".", "")


@app.post("/move")
def move():
    Path(request.form["name"]).replace(os.path.join(MODELS, "latest"))
    return "ok"
`,
    });
    const findings = (await scan(root)).findings;
    // \`Path(p).suffix.replace()\` is \`str.replace\`; \`Path(p).replace()\` moves a file.
    expect(findings.map((finding) => `${finding.rule} ${finding.subject.name}`).sort()).toEqual([
      "PLG802 POST /move",
      "PLG807 POST /load",
    ]);
  });

  it("apply a check to a variable assigned from a request global", async () => {
    const root = await project({
      "app.py": `import os
import re

from flask import Flask, abort, request

app = Flask(__name__)
BASE = os.path.realpath("reports")
REPORTS = ("daily", "weekly")


@app.post("/allowed")
def allowed():
    name = request.form["name"]
    if name not in REPORTS:
        abort(400)
    return open(os.path.join(BASE, name.strip())).read()


@app.post("/pattern")
def pattern():
    name = request.get_json()["name"]
    if not re.fullmatch(r"[a-z]+", name):
        abort(400)
    return open(os.path.join(BASE, name)).read()


@app.post("/suffix")
def suffix():
    name = request.form["name"]
    if not name.endswith(".csv"):
        abort(400)
    return open(os.path.join(BASE, name)).read()


@app.post("/other")
def other():
    name = request.form["name"]
    if name not in REPORTS:
        abort(400)
    return open(os.path.join(BASE, request.form["report"])).read()
`,
    });
    const findings = (await scan(root)).findings;
    // A suffix does not keep \`../\` out, and \`/other\` checks one value but reads another.
    expect(findings.map((finding) => `${finding.rule} ${finding.subject.name}`).sort()).toEqual([
      "PLG802 POST /other",
      "PLG802 POST /suffix",
    ]);
  });

  it("read a fullmatch pattern and separators replaced in a chain as one file name", async () => {
    const root = await project({
      "app.py": `import os
import re

from fastapi import FastAPI

app = FastAPI()
NOTES = os.path.realpath("notes")
NAME = re.compile(r"[A-Za-z0-9_-]+")


@app.get("/full")
def full(name: str):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
        return "bad name"
    return open(os.path.join(NOTES, name)).read()


@app.get("/compiled")
def compiled(name: str):
    if not NAME.fullmatch(name):
        return "bad name"
    return open(os.path.join(NOTES, name)).read()


@app.get("/prefix")
def prefix(name: str):
    if not re.match(r"[A-Za-z0-9_-]+", name):
        return "bad name"
    return open(os.path.join(NOTES, name)).read()


@app.get("/replaced")
def replaced(name: str):
    slug = name.replace("/", "-").replace("\\\\", "-")
    return open(os.path.join(NOTES, f"{slug}.md")).read()


@app.get("/climb")
def climb(name: str):
    slug = name.replace("../", "")
    return open(os.path.join(NOTES, f"{slug}.md")).read()
`,
    });
    const findings = (await scan(root)).findings;
    // \`re.match\` checks only the start of the name; \`....//\` loses \`../\` and keeps one.
    expect(findings.map((finding) => `${finding.rule} ${finding.subject.name}`).sort()).toEqual([
      "PLG802 GET /climb",
      "PLG802 GET /prefix",
    ]);
  });

  it("read a path helper's checks only at the returns they guard", async () => {
    const root = await project({
      "app.py": `import os
from flask import Flask, request

app = Flask(__name__)
BASE = os.path.realpath("reports")
DEFAULTS = {"summary": "summary.txt"}


def fallback_path(name):
    if name in DEFAULTS:
        return os.path.join(BASE, DEFAULTS[name])
    return os.path.join(BASE, name)


def known_path(name):
    if name not in DEFAULTS:
        raise ValueError(name)
    return os.path.join(BASE, name)


@app.get("/fallback")
def fallback():
    return open(fallback_path(request.args["name"])).read()


@app.get("/known")
def known():
    return open(known_path(request.args["name"])).read()
`,
    });
    const findings = (await scan(root)).findings;
    // The check in \`fallback_path\` guards only the first return.
    expect(findings.map((finding) => `${finding.rule} ${finding.subject.name}`)).toEqual([
      "PLG802 GET /fallback",
    ]);
  });

  it("drop a check helper's confinement once a checked name is assigned again", async () => {
    const root = await project({
      "server.js": `const express = require("express");
const fs = require("fs");
const path = require("path");
const app = express();
const BASE = path.resolve("files");
function isWithin(base, target) {
  const rel = path.relative(base, path.resolve(target));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}
app.get("/reassigned", (req, res) => {
  let target = path.resolve(BASE, req.query.name);
  if (!isWithin(BASE, target)) return res.status(400).end();
  target = req.query.other;
  res.send(fs.readFileSync(target));
});
app.get("/checked", (req, res) => {
  const target = path.resolve(BASE, req.query.name);
  if (!isWithin(BASE, target)) return res.status(400).end();
  res.send(fs.readFileSync(target));
});
`,
    });
    const findings = (await scan(root)).findings;
    expect(findings.map((finding) => `${finding.rule} ${finding.subject.name}`)).toEqual([
      "PLG802 GET /reassigned",
    ]);
  });

  it("count an if body that ends in a call as leaving only when the call never returns", async () => {
    const root = await project({
      "app.py": `import os
import sys
from flask import Flask, abort, request

app = Flask(__name__)
BASE = os.path.realpath("reports")
ALLOWED = {"summary", "totals"}


def reject(code):
    print("rejected", code)


@app.get("/logged")
def logged():
    name = request.args["name"]
    if name not in ALLOWED:
        reject(400)
    return open(os.path.join(BASE, name)).read()


@app.get("/aborted")
def aborted():
    name = request.args["name"]
    if name not in ALLOWED:
        abort(400)
    return open(os.path.join(BASE, name)).read()


@app.get("/exited")
def exited():
    name = request.args["name"]
    if name not in ALLOWED:
        sys.exit(1)
    return open(os.path.join(BASE, name)).read()
`,
      "local.py": `import os
from flask import Flask, request

app = Flask(__name__)
BASE = os.path.realpath("reports")
ALLOWED = {"summary", "totals"}


def abort(code):
    print("rejected", code)


@app.get("/own-abort")
def own_abort():
    name = request.args["name"]
    if name not in ALLOWED:
        abort(400)
    return open(os.path.join(BASE, name)).read()
`,
    });
    const findings = (await scan(root)).findings;
    // A project function named \`abort\` returns; Flask's raises.
    expect(findings.map((finding) => `${finding.rule} ${finding.subject.name}`).sort()).toEqual([
      "PLG802 GET /logged",
      "PLG802 GET /own-abort",
    ]);
  });

  it("bind unpacked parameters to a whole object passed in, and plain ones by position", async () => {
    const root = await project({
      "server.js": `const express = require("express");
const fs = require("fs");
const path = require("path");
const app = express();
const BASE = path.resolve("docs");
function readNamed({ name }) {
  return fs.readFileSync(path.join(BASE, name));
}
function readWith(name, { encoding }) {
  return fs.readFileSync(path.join(BASE, name), encoding);
}
app.get("/query", (req, res) => res.send(readNamed(req.query)));
app.get("/position", (req, res) => res.send(readWith(req.query.name, { encoding: "utf8" })));
app.get("/fixed", (req, res) => res.send(readNamed({ name: "readme.md", from: req.query.from })));
`,
    });
    const findings = (await scan(root)).findings;
    expect(findings.map((finding) => `${finding.rule} ${finding.subject.name}`).sort()).toEqual([
      "PLG802 GET /position",
      "PLG802 GET /query",
    ]);
  });

  it("allow a last component that may be `..` only where a file's contents are opened", async () => {
    const root = await project({
      "app.py": `import os
from pathlib import Path
from flask import Flask, jsonify, request

app = Flask(__name__)
BASE = os.path.realpath("uploads")


@app.get("/list")
def list_folder():
    name = os.path.basename(request.args["dir"])
    return jsonify(os.listdir(os.path.join(BASE, name)))


@app.post("/share")
def share():
    name = os.path.basename(request.form["dir"])
    Path(os.path.join(BASE, name)).chmod(0o777)
    return "ok"


@app.get("/read")
def read():
    name = os.path.basename(request.args["name"])
    return open(os.path.join(BASE, name)).read()
`,
    });
    const findings = (await scan(root)).findings;
    // \`..\` lists or changes the parent folder; opening it as a file fails.
    expect(findings.map((finding) => `${finding.rule} ${finding.subject.name}`).sort()).toEqual([
      "PLG802 GET /list",
      "PLG802 POST /share",
    ]);
  });

  it("read an absolute path among a program's arguments as a file path", async () => {
    const root = await project({
      "app.py": `import os
import subprocess
from flask import Flask, request
from werkzeug.utils import secure_filename

app = Flask(__name__)
UPLOADS = os.path.realpath("uploads")


@app.post("/remove")
def remove():
    subprocess.run(["rm", "-rf", os.path.realpath(request.form["path"])])
    return "ok"


@app.post("/convert")
def convert():
    name = secure_filename(request.form["name"])
    subprocess.run(["ffmpeg", "-i", name], cwd=UPLOADS)
    return "ok"


@app.post("/clean")
def clean():
    subprocess.run(["rm", "-f", os.path.abspath(os.path.join(UPLOADS, secure_filename(request.form["name"])))])
    return "ok"


def evict(name):
    subprocess.run(["rm", "-f", os.path.realpath(os.path.join(UPLOADS, name))])


@app.post("/evict")
def evict_raw():
    evict(request.form["name"])
    return "ok"


@app.post("/evict-safe")
def evict_safe():
    evict(secure_filename(request.form["name"]))
    return "ok"
`,
    });
    const findings = (await scan(root)).findings;
    // \`secure_filename\` keeps a leading \`-\`: only an absolute path cannot be an option.
    expect(findings.map((finding) => `${finding.rule} ${finding.subject.name}`).sort()).toEqual([
      "PLG801 POST /convert",
      "PLG801 POST /evict",
      "PLG801 POST /remove",
    ]);
  });

  it("read re.sub with a count as replacing only that many separators", async () => {
    const root = await project({
      "app.py": `import os
import re
from flask import Flask, request

app = Flask(__name__)
NOTES = os.path.realpath("notes")


@app.get("/once")
def once():
    name = re.sub(r"[/\\\\]", "", request.args["name"], count=1)
    return open(os.path.join(NOTES, name + ".txt")).read()


@app.get("/all")
def every():
    name = re.sub(r"[/\\\\]", "", request.args["name"], flags=re.IGNORECASE)
    return open(os.path.join(NOTES, name + ".txt")).read()
`,
    });
    const findings = (await scan(root)).findings;
    expect(findings.map((finding) => `${finding.rule} ${finding.subject.name}`)).toEqual([
      "PLG802 GET /once",
    ]);
  });

  it("trace the path os.chmod and os.makedirs act on, not their mode", async () => {
    const root = await project({
      "app.py": `import os
from flask import Flask, request

app = Flask(__name__)
BASE = os.path.realpath("shared")


@app.post("/open")
def open_up():
    os.chmod(os.path.join(BASE, request.form["dir"]), 0o777)
    return "ok"


@app.post("/create")
def create():
    os.makedirs(os.path.join(BASE, request.form["dir"]), 0o755, exist_ok=True)
    return "ok"


@app.post("/fixed")
def fixed():
    os.chmod(os.path.join(BASE, "public"), int(request.form["mode"], 8))
    return "ok"
`,
    });
    const findings = (await scan(root)).findings;
    expect(findings.map((finding) => `${finding.rule} ${finding.subject.name}`).sort()).toEqual([
      "PLG802 POST /create",
      "PLG802 POST /open",
    ]);
  });

  it("read generated ids as file name parts, and relative_to checked by exception", async () => {
    const root = await project({
      "server.js": `const express = require("express");
const fs = require("fs");
const path = require("path");
const { v4 } = require("uuid");
const app = express();
const BASE = path.resolve("drafts");
app.post("/save", (req, res) => {
  const name = \`\${String(req.body.title).replace(/[\\/\\\\]/g, "-")}-\${v4()}.json\`;
  fs.writeFileSync(path.join(BASE, name), "{}");
  res.end();
});
app.post("/raw", (req, res) => {
  fs.writeFileSync(path.join(BASE, \`\${req.body.title}-\${v4()}.json\`), "{}");
  res.end();
});
app.post("/record", (req, res) => {
  const record = { id: v4(), title: req.body.title };
  fs.writeFileSync(path.join(BASE, \`raw-\${record.id}.json\`), JSON.stringify(record));
  res.end();
});
app.post("/titled", (req, res) => {
  const record = { id: v4(), title: req.body.title };
  fs.writeFileSync(path.join(BASE, \`\${record.title}.json\`), JSON.stringify(record));
  res.end();
});
`,
      "app.py": `from pathlib import Path
from flask import Flask, abort, request

app = Flask(__name__)
DOCS = Path("docs").resolve()


@app.get("/doc")
def doc():
    full = (DOCS / request.args["name"]).resolve()
    try:
        full.relative_to(DOCS)
    except ValueError:
        abort(404)
    return full.read_text()


@app.get("/logged")
def logged():
    full = (DOCS / request.args["name"]).resolve()
    try:
        full.relative_to(DOCS)
    except ValueError:
        app.logger.warning("outside %s", full)
    return full.read_text()
`,
    });
    const findings = (await scan(root)).findings;
    expect(findings.map((finding) => `${finding.rule} ${finding.subject.name}`).sort()).toEqual([
      "PLG802 GET /logged",
      "PLG802 POST /raw",
      "PLG802 POST /titled",
    ]);
  });

  it("tell input that names the program from input among its arguments", async () => {
    const root = await project({
      "tools.py": `import shutil
import subprocess

from langchain_core.tools import tool
from openai import OpenAI

client = OpenAI()


@tool
def convert(path: str) -> int:
    """Convert a file."""
    return subprocess.run([shutil.which("ffmpeg"), "-i", path]).returncode


@tool
def launch(program: str) -> int:
    """Launch a program."""
    return subprocess.run([program, "--version"]).returncode


def summarize(text: str) -> int:
    reply = client.responses.create(model="gpt-4.1", input=text)
    return subprocess.run([shutil.which("say"), reply.output_text]).returncode
`,
    });
    const findings = (await scan(root)).findings;
    expect(
      findings.map((finding) => `${finding.rule} ${finding.severity} ${finding.title}`),
    ).toEqual(
      expect.arrayContaining([
        "PLG101 critical Tool `launch` runs a program named by model input",
        expect.stringMatching(
          /^PLG102 medium Tool `convert` passes model input to the arguments of/,
        ),
        expect.stringMatching(/^PLG401 medium .* is passed as arguments to/),
      ]),
    );
    expect(findings.filter((finding) => finding.rule === "PLG101")).toHaveLength(1);
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

  it("report the parameters of a library's public functions only when asked, and not whole paths", async () => {
    const reader = `import os

def read(name):
    return open(os.path.join("/srv", name)).read()
`;
    const root = await project({
      "pkg/store.py": `import os
import pickle
import subprocess
from pathlib import Path

import httpx


class FileStore:
    def __init__(self, root):
        self.root = Path(root)

    def get(self, key):
        return (self.root / key).read_bytes()

    def _read(self, path):
        return open(path).read()

    def load(self, path):
        return self._read(os.path.abspath(path))


def save(directory, name, data):
    with open(os.path.join(directory, name), "w") as handle:
        handle.write(data)


def read_template(config):
    return Path(config["template_path"]).read_text()


def fetch(url):
    return httpx.get(url).text


async def fetch_element(element):
    async with httpx.AsyncClient() as client:
        return (await client.get(element.url)).text


def run(command):
    return subprocess.run(command, shell=True)


def convert(source):
    return subprocess.run(f"ffmpeg -i {source} out.mp3", shell=True)


def restore(payload):
    return pickle.loads(payload)


def _secret(name):
    return open(os.path.join("/srv", name)).read()
`,
      "pkg/server.py": `import subprocess
from fastapi import FastAPI

app = FastAPI()

@app.get("/ping")
def ping(host: str):
    return subprocess.run(f"ping -c 1 {host}", shell=True)
`,
      "pkg/_internal.py": reader,
      "tests/test_store.py": reader,
      "pkg/index.ts": `import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = "/srv/data";

export class Store {
  async get(key: string) {
    return readFile(path.join(ROOT, key));
  }
}

export function evaluate(expression: string) {
  return eval(\`(\${expression})\`);
}

function hidden(key: string) {
  return readFile(path.join(ROOT, key));
}
`,
    });
    const library = await scan(root, { library: true });
    // A route's parameters are already request input: the route rule reports `ping` alone.
    expect(compactFindings(library.findings).sort()).toEqual([
      "PLG801 pkg/server.py:8 critical/high exposed `GET /ping` runs a shell command built from request input",
      "PLG901 pkg/store.py:42 critical/low `run` runs its parameter as a shell command",
      "PLG901 pkg/store.py:46 critical/medium `convert` runs a shell command built from its parameters",
      "PLG902 pkg/index.ts:8 high/low `Store.get` reads a file at a path built from its parameters",
      "PLG902 pkg/store.py:14 high/low `FileStore.get` reads a file at a path built from its parameters",
      "PLG902 pkg/store.py:29 high/low `read_template` reads a file at a path built from its parameters",
      "PLG904 pkg/store.py:38 high/low `fetch_element` requests a URL whose host comes from inside its parameters",
      "PLG905 pkg/index.ts:13 critical/medium `evaluate` evaluates code built from its parameters with `eval`",
      "PLG907 pkg/store.py:50 high/low `restore` deserializes its parameter with `pickle.loads`",
    ]);
    // `FileStore.__init__`, `get` and `load`, seven module functions, `ping`, `Store.get` and `evaluate`.
    expect(library.library).toEqual({ functions: 13 });
    const get = library.findings.find((finding) => finding.title.startsWith("`FileStore.get`"));
    expect(get?.subject).toEqual({
      kind: "function",
      name: "FileStore.get",
      id: "pkg/store.py#FileStore.get",
    });
    expect(get?.evidence.map((step) => step.message)).toEqual([
      "public function `FileStore.get`",
      "reads the path `self.root / key` with `pathlib.Path().read_bytes`",
    ]);
    const plain = await scan(root);
    expect(plain.library).toBeUndefined();
    expect(plain.findings.map((finding) => finding.rule)).toEqual(["PLG801"]);
    expect(JSON.stringify(plain.inventory)).not.toContain('"given"');
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
