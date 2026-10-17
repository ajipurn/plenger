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

describe("JS/TS facts: OpenAI SDK", async () => {
  const facts = await factsOfFixture("frameworks/js/openai.ts");

  it("records default, aliased and type-only imports", () => {
    expect(
      facts.imports.map(({ module, imported, local, kind, typeOnly }) => [
        module,
        imported,
        local,
        kind,
        typeOnly,
      ]),
    ).toEqual([
      ["openai", "default", "OpenAI", "default", false],
      ["openai", "OpenAI", "NamedOpenAI", "member", false],
      [
        "openai/resources",
        "ChatCompletionMessageParam",
        "ChatCompletionMessageParam",
        "member",
        true,
      ],
    ]);
  });

  it("resolves calls through default and named imports", () => {
    const create = callTo(facts, "openai#default().chat.completions.create");
    expect(create.scope).toBe("answer");
    expect(callTo(facts, "openai#OpenAI().responses.create").scope).toBe("respond");
  });

  it("links a messages variable and marks parameters in shorthand properties", () => {
    const create = callTo(facts, "openai#default().chat.completions.create");
    const messages = assigned(facts, entry(argument(create, 0), "messages"));
    const system = messages.kind === "list" ? messages.items[0] : undefined;
    expect(entry(system, "content")).toEqual({
      kind: "string",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: summaries keep the template source as written
      value: "You are a support assistant. Notes: ${notes}",
      template: [{ kind: "name", text: "notes", ref: null, param: true }],
    });
    const respond = callTo(facts, "openai#OpenAI().responses.create");
    expect(entry(argument(respond, 0), "input")).toMatchObject({ kind: "name", param: true });
  });

  it("resolves environment variables as globals", () => {
    const client = callTo(facts, "openai#default");
    expect(refName(entry(argument(client, 0), "apiKey"))).toBe("process.env.OPENAI_API_KEY");
  });
});

describe("JS/TS facts: Anthropic SDK in a class", async () => {
  const facts = await factsOfFixture("frameworks/js/anthropic.ts");

  it("follows private fields and fields assigned in the constructor", () => {
    const creates = callsTo(facts, "@anthropic-ai/sdk#default().messages.create");
    expect(creates.map((call) => call.callee)).toEqual([
      "this.#client.messages.create",
      "this.backup.messages.create",
    ]);
    expect(assigned(facts, entry(argument(creates[0] as never, 0), "model"))).toEqual({
      kind: "string",
      value: "claude-sonnet-4-5",
    });
  });

  it("links this.method() to arrow-function class fields", () => {
    expect(callTo(facts, "SupportAgent.runCommand").ref?.kind).toBe("local");
    expect(definition(facts, "SupportAgent.runCommand")).toMatchObject({
      kind: "method",
      params: ["command"],
    });
    expect(callTo(facts, "node:child_process#execSync").scope).toBe("SupportAgent.runCommand");
  });

  it("reads string subscripts as members", () => {
    const backup = callsTo(facts, "@anthropic-ai/sdk#default")[1];
    expect(refName(entry(argument(backup as never, 0), "apiKey"))).toBe(
      "process.env.ANTHROPIC_API_KEY",
    );
  });
});

describe("JS/TS facts: Vercel AI SDK", async () => {
  const facts = await factsOfFixture("frameworks/js/vercel-ai.ts");

  it("names functions after the object property that holds them", () => {
    const tool = callTo(facts, "ai#tool");
    expect(entry(argument(tool, 0), "execute")).toEqual({
      kind: "function",
      definition: "execute",
    });
    expect(definition(facts, "execute")).toMatchObject({ async: true, params: ["city"] });
    const fetchCall = callTo(facts, "fetch");
    expect(fetchCall.scope).toBe("execute");
    expect(argument(fetchCall, 0)).toMatchObject({
      kind: "string",
      template: [{ text: "city", param: true }],
    });
  });

  it("resolves shorthand tool entries and destructured results", () => {
    const generate = callTo(facts, "ai#generateText");
    expect(refName(entry(entry(argument(generate, 0), "tools"), "weather"))).toBe("ai#tool()");
    expect(refName(entry(argument(generate, 0), "model"))).toBeUndefined();
    const text = facts.assignments.find((assignment) => assignment.target === "text");
    expect(text).toMatchObject({ member: "text", value: { kind: "call" } });
  });
});

describe("JS/TS facts: LangChain.js and LangGraph.js", async () => {
  const facts = await factsOfFixture("frameworks/js/langgraph.ts");

  it("resolves namespace imports and tools built from anonymous functions", () => {
    const write = callTo(facts, "node:fs/promises#writeFile");
    const tool = callTo(facts, "@langchain/core/tools#tool");
    expect(argument(tool, 0)).toEqual({ kind: "function", definition: write.scope });
    expect(entry(argument(tool, 1), "name")).toEqual({ kind: "string", value: "write_note" });
  });

  it("follows agents built from factories", () => {
    expect(callTo(facts, "@langchain/langgraph/prebuilt#createReactAgent().invoke").scope).toBe(
      "ask",
    );
    const agent = callTo(facts, "@langchain/langgraph/prebuilt#createReactAgent");
    const tools = entry(argument(agent, 0), "tools");
    expect(tools.kind === "list" ? tools.items.map(refName) : []).toEqual([
      "@langchain/core/tools#tool()",
    ]);
  });
});

describe("JS/TS facts: MCP TypeScript SDK", async () => {
  const facts = await factsOfFixture("frameworks/js/mcp-server.ts");

  it("resolves tool registration and the handlers' calls", () => {
    const run = callTo(facts, "@modelcontextprotocol/sdk/server/mcp.js#McpServer().tool");
    expect(argument(run, 0)).toEqual({ kind: "string", value: "run" });
    const handler = argument(run, 2);
    expect(handler.kind).toBe("function");
    const exec = callTo(facts, "node:child_process#exec");
    expect(exec.scope).toBe(handler.kind === "function" ? handler.definition : undefined);
    expect(argument(exec, 0)).toMatchObject({ param: true });
    callTo(facts, "@modelcontextprotocol/sdk/server/mcp.js#McpServer().registerTool");
    callTo(facts, "@modelcontextprotocol/sdk/server/mcp.js#McpServer().connect");
  });
});

describe("JS/TS facts: CommonJS Express server", async () => {
  const facts = await factsOfFixture("frameworks/js/express-server.cjs");

  it("records require calls as imports", () => {
    expect(facts.imports.map(({ module, local, kind }) => [module, local, kind])).toEqual([
      ["express", "express", "require"],
      ["@anthropic-ai/sdk", "Anthropic", "require"],
      ["openai", null, "require"],
    ]);
  });

  it("resolves through required modules and destructured requires", () => {
    const post = callTo(facts, "express().post");
    expect(argument(post, 0)).toEqual({ kind: "string", value: "/chat" });
    const create = callTo(facts, "@anthropic-ai/sdk().messages.create");
    expect(create.scope).toBe(
      argument(post, 1).kind === "function"
        ? (argument(post, 1) as { definition: string }).definition
        : "",
    );
    callTo(facts, "openai#OpenAI().chat.completions.create");
  });

  it("marks module.exports members as exported", () => {
    expect(definition(facts, "summarize").exported).toBe(true);
  });
});

describe("JS/TS facts: Next.js route handler", async () => {
  const facts = await factsOfFixture("frameworks/js/app/api/chat/route.ts");

  it("records exported handlers and what flows into the model call", () => {
    expect(definition(facts, "POST")).toMatchObject({
      exported: true,
      async: true,
      params: ["req"],
    });
    const stream = callTo(facts, "ai#streamText");
    const messages = entry(argument(stream, 0), "messages");
    expect(assigned(facts, messages)).toMatchObject({ kind: "call" });
    expect(facts.assignments.find((fact) => fact.target === "messages")?.member).toBe("messages");
  });
});

describe("JS/TS facts: syntax coverage", () => {
  it("records TypeScript decorators on classes and methods", async () => {
    const facts = await factsOf(
      "typescript",
      'import { Injectable, Tool } from "framework";\n@Injectable()\nexport class Tools {\n  @Tool({ name: "search" })\n  search(query: string) { return query; }\n}\n',
    );
    expect(definition(facts, "Tools")).toMatchObject({
      exported: true,
      decorators: [{ ref: { name: "framework#Injectable()" } }],
    });
    expect(definition(facts, "Tools.search").decorators[0]).toMatchObject({
      ref: { name: "framework#Tool()" },
      arguments: [{ value: { kind: "object" } }],
    });
  });

  it("tracks export clauses, CommonJS exports and re-exports", async () => {
    const facts = await factsOf(
      "javascript",
      'function a() {}\nfunction b() {}\nexport { a };\nexports.handler = async () => {};\nexport * from "x";\nexport { c } from "y";\n',
    );
    expect(facts.definitions.map((fact) => [fact.id, fact.exported])).toEqual([
      ["a", true],
      ["b", false],
      ["handler", true],
    ]);
    expect(facts.imports.map(({ module, imported, kind }) => [module, imported, kind])).toEqual([
      ["x", "*", "reexport"],
      ["y", "c", "reexport"],
    ]);
  });

  it("records dynamic imports and resolves through them", async () => {
    const facts = await factsOf(
      "javascript",
      'const mod = await import("openai");\nnew mod.OpenAI();\n',
    );
    expect(facts.imports[0]).toMatchObject({ module: "openai", kind: "dynamic" });
    callTo(facts, "openai#OpenAI");
  });

  it("keeps `this` in arrow functions but not in plain functions inside methods", async () => {
    const facts = await factsOf(
      "javascript",
      'import OpenAI from "openai";\nclass A {\n  client = new OpenAI();\n  run() {\n    [1].map(() => this.client.x());\n    [1].map(function () { this.client.y(); });\n  }\n}\n',
    );
    expect(
      facts.calls
        .filter((call) => call.callee.startsWith("this."))
        .map((call) => call.ref?.name ?? null),
    ).toEqual(["openai#default().x", null]);
  });

  it("does not resolve a name shadowed by an arrow-function parameter", async () => {
    const facts = await factsOf(
      "typescript",
      'import OpenAI from "openai";\nconst client = new OpenAI();\nconst f = (client: any) => client.go();\nclient.ok();\n',
    );
    expect(facts.calls.map((call) => call.ref?.name ?? null)).toEqual([
      "openai#default",
      null,
      "openai#default().ok",
    ]);
  });

  it("parses TSX components and the calls inside JSX", async () => {
    const facts = await factsOf(
      "tsx",
      'import { useChat } from "@ai-sdk/react";\nexport default function Chat() {\n  const { messages } = useChat();\n  return <ul>{messages.map((m) => <li key={m.id}>{m.content}</li>)}</ul>;\n}\n',
    );
    expect(definition(facts, "Chat").exported).toBe(true);
    callTo(facts, "@ai-sdk/react#useChat");
    callTo(facts, "@ai-sdk/react#useChat().messages.map");
  });
});

describe("JavaScript facts: guards and fixed collections", () => {
  const guards = (facts: Awaited<ReturnType<typeof factsOf>>) =>
    (facts.guards ?? []).map((guard) => [
      guard.subject.kind === "name" ? guard.subject.text : guard.subject.kind,
      guard.allowed.kind,
      `${guard.region.line}-${guard.region.endLine}`,
    ]);

  it("records what membership and equality tests limit", async () => {
    const facts = await factsOf(
      "typescript",
      [
        "function f(url: URL, name: string, key: string) {",
        '  if (url.protocol !== "https:" || !HOSTS.has(url.hostname)) throw new Error("no");',
        "  if (!LIST.includes(name)) { return; }",
        '  if (key in TABLE && name === "a") {',
        "    run(key);",
        "  }",
        "  if (!LIST.includes(name)) log(name);",
        "  run(name);",
        "}",
      ].join("\n"),
    );
    expect(guards(facts)).toEqual([
      ["url.protocol", "string", "2-9"],
      ["url.hostname", "name", "2-9"],
      ["name", "name", "3-9"],
      ["key", "name", "4-6"],
      ["name", "string", "4-6"],
    ]);
  });

  it("records name patterns, excluded text and path prefixes", async () => {
    const facts = await factsOf(
      "typescript",
      [
        "function read(name: string, target: string) {",
        '  if (!/^[\\w-]+$/.test(name) || name.includes("..")) throw new Error("bad name");',
        "  if (!target.startsWith(NOTES)) return;",
        "}",
      ].join("\n"),
    );
    expect(
      (facts.guards ?? []).map((guard) => [
        guard.test,
        guard.subject.kind === "name" ? guard.subject.text : guard.subject.kind,
        guard.allowed.kind === "literal" || guard.allowed.kind === "name"
          ? guard.allowed.text
          : guard.allowed.kind === "string"
            ? guard.allowed.value
            : guard.allowed.kind,
      ]),
    ).toEqual([
      ["matches", "name", "/^[\\w-]+$/"],
      ["excludes", "name", ".."],
      ["within", "target", "NOTES"],
    ]);
  });

  it("marks collections changed in place", async () => {
    const facts = await factsOf(
      "javascript",
      [
        'const FIXED = { a: "ls" };',
        'const SET_LATER = { a: "ls" };',
        'SET_LATER.b = "rm";',
        'const INDEXED = { a: "ls" };',
        'INDEXED["b"] = "rm";',
        'const REMOVED = { a: "ls" };',
        "delete REMOVED.a;",
      ].join("\n"),
    );
    expect(
      facts.assignments
        .filter((item) => /^[A-Z_]+$/.test(item.target))
        .map((item) => [item.target, item.mutated ?? false]),
    ).toEqual([
      ["FIXED", false],
      ["SET_LATER", true],
      ["INDEXED", true],
      ["REMOVED", true],
    ]);
  });
});
