import { describe, expect, it } from "vitest";
import {
  argument,
  assigned,
  callsTo,
  callTo,
  definition,
  entry,
  factsOf,
  factsOfFixture,
  refName,
} from "./helpers.ts";

describe("Python facts: OpenAI SDK", async () => {
  const facts = await factsOfFixture("frameworks/python/openai_chat.py");

  it("records every import form", () => {
    expect(
      facts.imports.map(({ module, imported, local, kind }) => [module, imported, local, kind]),
    ).toEqual([
      ["openai", null, "openai", "module"],
      ["openai", "AsyncOpenAI", "AsyncOpenAI", "member"],
      ["openai", "OpenAI", "OpenAI", "member"],
    ]);
  });

  it("resolves calls through a module-level client", () => {
    const create = callTo(facts, "openai.OpenAI().chat.completions.create");
    expect(create.scope).toBe("answer");
    expect(create.ref).toMatchObject({
      kind: "import",
      module: "openai",
      path: "OpenAI().chat.completions.create",
    });
  });

  it("resolves `async with ... as` bindings and inline call chains", () => {
    expect(callTo(facts, "openai.AsyncOpenAI().responses.create").scope).toBe("stream");
    expect(callTo(facts, "openai.OpenAI().completions.create").scope).toBe("legacy");
  });

  it("does not resolve a name shadowed by a parameter", () => {
    const shadowed = facts.calls.find((call) => call.scope === "shadowed");
    expect(shadowed?.callee).toBe("client.chat.completions.create");
    expect(shadowed?.ref).toBeNull();
  });

  it("summarises prompts: concatenation, constants, parameters and f-strings", () => {
    const messages = argument(callTo(facts, "openai.OpenAI().chat.completions.create"), "messages");
    expect(messages.kind).toBe("list");
    const [system, user] = messages.kind === "list" ? messages.items : [];

    const content = entry(system, "content");
    expect(content.kind).toBe("concat");
    const parts = content.kind === "concat" ? content.parts : [];
    expect(assigned(facts, parts[0])).toMatchObject({
      kind: "string",
      value: expect.stringContaining("You are a support assistant"),
    });
    expect(parts[2]).toMatchObject({ kind: "name", text: "notes", param: true });

    expect(entry(user, "content")).toEqual({
      kind: "string",
      value: "Question: {question}",
      template: [{ kind: "name", text: "question", ref: null, param: true }],
    });
  });
});

describe("Python facts: Anthropic SDK in a class", async () => {
  const facts = await factsOfFixture("frameworks/python/anthropic_agent.py");

  it("follows self attributes assigned in __init__", () => {
    const create = callTo(facts, "anthropic.Anthropic().messages.create");
    expect(create.scope).toBe("SupportAgent.step");
    expect(assigned(facts, argument(create, "model"))).toEqual({
      kind: "string",
      value: "claude-sonnet-4-5",
    });
    expect(assigned(facts, argument(create, "tools")).kind).toBe("list");
    expect(argument(create, "messages")).toMatchObject({ kind: "list" });
  });

  it("links self.method() to the method definition", () => {
    const call = callTo(facts, "SupportAgent.run_command");
    expect(call.ref).toMatchObject({ kind: "local", definition: "SupportAgent.run_command" });
    expect(definition(facts, "SupportAgent.run_command")).toMatchObject({
      kind: "method",
      params: ["self", "command"],
    });
  });

  it("marks parameters flowing into a subprocess call", () => {
    const run = callTo(facts, "subprocess.run");
    expect(argument(run, 0)).toMatchObject({ kind: "name", text: "command", param: true });
    expect(argument(run, "shell")).toEqual({ kind: "literal", text: "True" });
  });
});

describe("Python facts: LangChain and LangGraph", async () => {
  const facts = await factsOfFixture("frameworks/python/langgraph_agent.py");

  it("describes tool decorators with and without arguments", () => {
    expect(definition(facts, "search_docs")).toMatchObject({
      decorators: [{ text: "tool", ref: { name: "langchain_core.tools.tool" }, arguments: null }],
      doc: "Search the internal documentation.",
    });
    const [decorator] = definition(facts, "delete_file").decorators;
    expect(decorator?.ref?.name).toBe("langchain_core.tools.tool()");
    expect(decorator?.arguments).toEqual([
      { keyword: null, value: { kind: "string", value: "delete_file" } },
      { keyword: "return_direct", value: { kind: "literal", text: "True" } },
    ]);
  });

  it("resolves base classes and records imports inside functions", () => {
    expect(refName(definition(facts, "FetchTool").bases[0])).toBe("langchain_core.tools.BaseTool");
    expect(facts.imports.find((fact) => fact.module === "os")).toMatchObject({
      scope: "delete_file",
    });
    expect(callTo(facts, "os.remove").scope).toBe("delete_file");
  });

  it("follows agents built from factories and chained calls", () => {
    expect(callTo(facts, "langgraph.prebuilt.create_react_agent().invoke").scope).toBe("ask");
    callTo(facts, "langchain_openai.ChatOpenAI().bind_tools().invoke");
    const tools = argument(callTo(facts, "langgraph.prebuilt.create_react_agent"), "tools");
    expect(tools.kind === "list" ? tools.items.map((item) => item.kind) : []).toEqual([
      "name",
      "name",
      "call",
    ]);
  });
});

describe("Python facts: MCP (FastMCP)", async () => {
  const facts = await factsOfFixture("frameworks/python/fastmcp_server.py");

  it("resolves decorators on a FastMCP instance", () => {
    expect(definition(facts, "read_file").decorators[0]?.ref?.name).toBe(
      "mcp.server.fastmcp.FastMCP().tool()",
    );
    expect(definition(facts, "run")).toMatchObject({
      async: true,
      decorators: [{ arguments: [{ keyword: "name", value: { kind: "string", value: "exec" } }] }],
    });
    expect(definition(facts, "config").decorators[0]?.ref?.name).toBe(
      "mcp.server.fastmcp.FastMCP().resource()",
    );
  });

  it("resolves builtins as globals and follows `with open() as`", () => {
    expect(callTo(facts, "open").ref?.kind).toBe("global");
    expect(callTo(facts, "open().read").scope).toBe("read_file");
    expect(callTo(facts, "os.popen().read").scope).toBe("run");
  });
});

describe("Python facts: llmfy", async () => {
  const facts = await factsOfFixture("frameworks/python/llmfy_agent.py");

  it("describes @Tool() functions, including ones nested in a builder", () => {
    expect(definition(facts, "get_order").decorators[0]?.ref?.name).toBe("llmfy.Tool()");
    expect(definition(facts, "build_agent.cancel_order")).toMatchObject({
      parent: "build_agent",
      decorators: [{ ref: { name: "llmfy.Tool()" } }],
      doc: "Cancel an order.",
    });
  });

  it("links the system message template and the variables filled at invoke time", () => {
    const [framework] = callsTo(facts, "llmfy.LLMfy");
    expect(assigned(facts, argument(framework as never, "system_message"))).toMatchObject({
      kind: "string",
      value: expect.stringContaining("{{info}}"),
    });
    const invoke = callTo(facts, "llmfy.LLMfy().invoke");
    expect(argument(invoke, "info")).toMatchObject({ kind: "name", param: true });
  });

  it("follows tool registration and the FlowEngine graph", () => {
    const tools = assigned(facts, argument(callTo(facts, "llmfy.LLMfy().register_tool"), 0));
    expect(tools.kind === "list" ? tools.items.map(refName) : []).toEqual([
      "get_order",
      "build_agent.cancel_order",
    ]);
    const [main] = callsTo(facts, "llmfy.FlowEngine().add_node");
    expect(refName(argument(main as never, 1))).toBe("build_agent.main_orchestrator");
    const edges = callTo(facts, "llmfy.FlowEngine().add_conditional_edges");
    expect(argument(edges, 1)).toMatchObject({ kind: "function" });
    expect(callTo(facts, "build_agent().invoke").scope).toBe("chat");
  });
});

describe("Python facts: FastAPI routes", async () => {
  const facts = await factsOfFixture("frameworks/python/fastapi_app.py");

  it("resolves route decorators on FastAPI and APIRouter instances", () => {
    expect(definition(facts, "ask_route").decorators[0]).toMatchObject({
      ref: { name: "fastapi.APIRouter().post()" },
      arguments: [{ keyword: null, value: { kind: "string", value: "/ask" } }],
    });
    expect(definition(facts, "answer_route").decorators[0]?.ref?.name).toBe(
      "fastapi.FastAPI().get()",
    );
  });

  it("keeps relative imports relative", () => {
    expect(facts.imports.map(({ module, imported }) => [module, imported])).toContainEqual([
      ".",
      "openai_chat",
    ]);
    callTo(facts, ".langgraph_agent.ask");
    callTo(facts, ".openai_chat.answer");
  });
});

describe("Python facts: resolution rules", () => {
  it("binds the top package for `import a.b.c` and the full module for an alias", async () => {
    const facts = await factsOf("python", "import a.b.c\nimport a.b as x\na.b.c.d()\nx.f()\n");
    expect(facts.calls.map((call) => call.ref?.name)).toEqual(["a.b.c.d", "a.b.f"]);
  });

  it("uses the nearest earlier assignment in the same scope", async () => {
    const facts = await factsOf(
      "python",
      "from openai import OpenAI\nfrom anthropic import Anthropic\nx = OpenAI()\nx.a()\nx = Anthropic()\nx.b()\n",
    );
    expect(facts.calls.map((call) => call.ref?.name)).toEqual([
      "openai.OpenAI",
      "openai.OpenAI().a",
      "anthropic.Anthropic",
      "anthropic.Anthropic().b",
    ]);
  });

  it("sees module variables assigned after the function that uses them", async () => {
    const facts = await factsOf(
      "python",
      "def run():\n    client.go()\n\nfrom openai import OpenAI\nclient = OpenAI()\n",
    );
    expect(facts.calls[0]?.ref?.name).toBe("openai.OpenAI().go");
  });

  it("does not let methods see names bound in the class body", async () => {
    const facts = await factsOf(
      "python",
      "from openai import OpenAI\nclass C:\n    client = OpenAI()\n    def m(self):\n        client.x()\n        self.client.y()\n",
    );
    expect(facts.calls.map((call) => [call.callee, call.ref?.kind, call.ref?.name])).toEqual([
      ["OpenAI", "import", "openai.OpenAI"],
      ["client.x", "global", "client.x"],
      ["self.client.y", "import", "openai.OpenAI().y"],
    ]);
  });

  it("stops on self-referencing assignments", async () => {
    const facts = await factsOf(
      "python",
      "x = x.y\nx.z()\nclass C:\n    def m(self):\n        self.a = self.a.b\n        self.a.c()\n",
    );
    expect(facts.calls.map((call) => call.callee)).toEqual(["x.z", "self.a.c"]);
  });

  it("still extracts facts from a file with syntax errors", async () => {
    const facts = await factsOf("python", "import os\ndef broken(:\n    pass\nos.system('ls')\n");
    expect(callsTo(facts, "os.system")).toHaveLength(1);
  });

  it("truncates long strings and says so", async () => {
    const facts = await factsOf("python", `PROMPT = "${"x".repeat(3000)}"\n`);
    expect(facts.assignments[0]?.value).toMatchObject({ kind: "string", truncated: true });
  });
});

describe("Python facts: guards and fixed collections", () => {
  const guards = (facts: Awaited<ReturnType<typeof factsOf>>) =>
    (facts.guards ?? []).map((guard) => [
      guard.scope,
      guard.subject.kind === "name" ? guard.subject.text : guard.subject.kind,
      guard.allowed.kind,
      `${guard.region.line}-${guard.region.endLine}`,
    ]);

  it("records what an exiting `if` limits in the rest of its block", async () => {
    const facts = await factsOf(
      "python",
      [
        "def save(name, mode, url):",
        "    if name not in REPORTS or mode != 'w':",
        "        raise ValueError()",
        "    if not (url in HOSTS):",
        "        return None",
        "    write(name, mode)",
        "    for item in name:",
        "        if item not in REPORTS:",
        "            continue",
        "        write(item)",
        "",
      ].join("\n"),
    );
    expect(guards(facts)).toEqual([
      ["save", "name", "name", "3-10"],
      ["save", "mode", "string", "3-10"],
      ["save", "url", "name", "5-10"],
      ["save", "item", "name", "9-10"],
    ]);
  });

  it("records what a test limits inside its body, and nothing after one that does not exit", async () => {
    const facts = await factsOf(
      "python",
      [
        "def run(kind, other):",
        "    if kind in COMMANDS and 'ok' == other:",
        "        execute(kind)",
        "    if kind not in COMMANDS:",
        "        print('unknown', kind)",
        "    if kind in COMMANDS or other in COMMANDS:",
        "        execute(kind)",
        "",
      ].join("\n"),
    );
    expect(guards(facts)).toEqual([
      ["run", "kind", "name", "3-3"],
      ["run", "other", "string", "3-3"],
    ]);
  });

  it("records name patterns, excluded text and path prefixes", async () => {
    const facts = await factsOf(
      "python",
      [
        "def read(name, path):",
        "    if not re.match(r'^[a-z0-9_-]+$', name):",
        "        return None",
        "    if '..' in name or '/' in name:",
        "        return None",
        "    if not str(path).startswith(str(BASE)):",
        "        raise ValueError(path)",
        "    if SAFE.fullmatch(path):",
        "        open(path)",
        "",
      ].join("\n"),
    );
    expect(
      (facts.guards ?? []).map((guard) => [
        guard.test,
        guard.subject.kind === "name" ? guard.subject.text : guard.subject.kind,
        guard.allowed.kind === "string" ? guard.allowed.value : guard.allowed.kind,
      ]),
    ).toEqual([
      ["matches", "name", "^[a-z0-9_-]+$"],
      ["excludes", "name", ".."],
      ["excludes", "name", "/"],
      ["within", "path", "name"],
      ["matches", "path", "name"],
    ]);
  });

  it("lets a guard in a try body protect the code after the try when every handler exits", async () => {
    const facts = await factsOf(
      "python",
      [
        "def save(name):",
        "    try:",
        "        if name not in REPORTS:",
        "            return None",
        "    except KeyError:",
        "        return None",
        "    write(name)",
        "    try:",
        "        if name not in REPORTS:",
        "            return None",
        "    except KeyError:",
        "        log(name)",
        "    write(name)",
        "",
      ].join("\n"),
    );
    expect((facts.guards ?? []).map((guard) => [guard.region.line, guard.region.endLine])).toEqual([
      [4, 13],
      [10, 10],
    ]);
  });

  it("binds unpacked names to items of the value", async () => {
    const facts = await factsOf(
      "python",
      "def f(data):\n    path, body = data.split('|', 1)\n    a, b = 1, data\n",
    );
    expect(
      facts.assignments.map((item) => [item.target, item.member ?? "", item.value.kind]),
    ).toEqual([
      ["path", "[*]", "call"],
      ["body", "[*]", "call"],
      ["a", "", "literal"],
      ["b", "", "name"],
    ]);
  });

  it("tells a prefix check from a component-wise containment check", async () => {
    const facts = await factsOf(
      "python",
      "def f(path):\n    if not path.is_relative_to(BASE):\n        raise ValueError(path)\n    if not str(path).startswith(str(BASE) + os.sep):\n        raise ValueError(path)\n",
    );
    expect((facts.guards ?? []).map((guard) => [guard.test, guard.allowed.kind])).toEqual([
      ["inside", "name"],
      ["within", "concat"],
    ]);
  });

  it("records that a failing absolute-path check leaves a relative path", async () => {
    const facts = await factsOf(
      "python",
      "def f(name, other):\n    if '..' in name or name.startswith('/'):\n        return None\n    if os.path.isabs(other):\n        return None\n",
    );
    expect(
      (facts.guards ?? []).map((guard) => [
        guard.test,
        guard.subject.kind === "name" ? guard.subject.text : guard.subject.kind,
      ]),
    ).toEqual([
      ["excludes", "name"],
      ["relative", "name"],
      // The body of the test that holds: a call, read only when it is a project function.
      ["call", "call"],
      ["relative", "other"],
    ]);
  });

  it("resolves pathlib division and records the expression a method is called on", async () => {
    const facts = await factsOf(
      "python",
      "from pathlib import Path\nBASE = Path('notes')\ndef f(name):\n    target = BASE / name\n    target.read_text()\n    (BASE / name).read_text()\n",
    );
    const reads = facts.calls.filter((call) => call.callee.endsWith("read_text"));
    expect(reads.map((call) => call.ref?.name)).toEqual([
      "pathlib.Path().read_text",
      "pathlib.Path().read_text",
    ]);
    expect(reads[1]?.object).toMatchObject({ kind: "other", text: "BASE / name" });
  });

  it("marks lookups and collections changed in place", async () => {
    const facts = await factsOf(
      "python",
      [
        "FIXED = {'a': ['ls']}",
        "CHANGED = {'a': ['ls']}",
        "CHANGED['b'] = ['rm']",
        "SHRUNK = {'a': 1}",
        "del SHRUNK['a']",
        "COUNTS = {'a': 1}",
        "COUNTS['a'] += 1",
        "def f(key):",
        "    return FIXED[key]",
        "",
      ].join("\n"),
    );
    expect(facts.assignments.map((item) => [item.target, item.mutated ?? false])).toEqual([
      ["FIXED", false],
      ["CHANGED", true],
      ["SHRUNK", true],
      ["COUNTS", true],
    ]);
    expect(definition(facts, "f").returns?.[0]).toMatchObject({
      kind: "other",
      text: "FIXED[key]",
      subscript: true,
    });
  });

  it("marks parameters a dependency fills in and scalar parameters", async () => {
    const facts = await factsOf(
      "python",
      [
        "from typing import Annotated",
        "from fastapi import Depends, Security",
        "def route(name: str, db=Depends(get_db), user: User = Security(auth),",
        "          base: Annotated[str, Depends(folder)] = '', limit: int = 10,",
        "          day: date | None = None, key: Annotated[UUID, Path()] = None):",
        "    return name",
        "def plain(name):",
        "    return name",
        "",
      ].join("\n"),
    );
    expect(definition(facts, "route").injected).toEqual(["db", "user", "base"]);
    expect(definition(facts, "route").scalars).toEqual(["limit", "day", "key"]);
    expect(definition(facts, "plain").injected).toBeUndefined();
  });

  it("records what a check helper establishes when it returns true", async () => {
    const facts = await factsOf(
      "python",
      [
        "import os",
        "def is_within(base, path):",
        "    rel = os.path.relpath(os.path.realpath(path), base)",
        "    if rel == '':",
        "        return False",
        "    return rel != '..' and not rel.startswith('../') and not os.path.isabs(rel)",
        "def allowed(cmd):",
        "    if cmd not in COMMANDS:",
        "        return False",
        "    return True",
        "def mixed(name):",
        "    if name == 'a':",
        "        return True",
        "    return name.isalpha()",
        "",
      ].join("\n"),
    );
    const checks = (id: string) =>
      (definition(facts, id).checks ?? []).map((check) => [
        check.test ?? "member",
        check.subject.kind === "name" ? check.subject.text : check.subject.kind,
      ]);
    // `rel != '..'`, `rel.startswith('../')` failing, `os.path.isabs(rel)` failing, and
    // `rel != ''` from the early return.
    expect(checks("is_within")).toEqual([
      ["differs", "rel"],
      ["descends", "rel"],
      ["relative", "rel"],
      ["differs", "rel"],
    ]);
    expect(checks("allowed")).toEqual([["member", "cmd"]]);
    // A check that only one of the true returns makes is not established.
    expect(checks("mixed")).toEqual([]);
  });
});
