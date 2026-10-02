import { describe, expect, it } from "vitest";
import {
  credentialOf,
  environmentValue,
  provenanceOf,
  select,
  summarizeText,
  urlString,
} from "../src/inventory/values.ts";
import { factsOf } from "./helpers.ts";

async function callToF(source: string, grammar: "python" | "typescript" = "python") {
  const facts = await factsOf(grammar, source);
  const call = facts.calls.find((candidate) => candidate.callee === "f");
  if (call === undefined) throw new Error("no call to f");
  return { facts, call };
}

describe("select", () => {
  it("reads keywords, positionals and options-object properties", async () => {
    const { facts, call } = await callToF('f("a", model="m")\n');
    expect(select(call.arguments, facts, "model")).toEqual([{ kind: "string", value: "m" }]);
    expect(select(call.arguments, facts, "#0")).toEqual([{ kind: "string", value: "a" }]);
    expect(select(call.arguments, facts, "#-1")).toEqual([{ kind: "string", value: "a" }]);
    const js = await callToF('f({ model: "m" });\n', "typescript");
    expect(select(js.call.arguments, js.facts, "model")).toEqual([{ kind: "string", value: "m" }]);
  });

  it("follows variables, filters list items and takes the first alternative that matches", async () => {
    const { facts, call } = await callToF(
      'MESSAGES = [{"role": "system", "content": "s"}, ("user", "u")]\nf(messages=MESSAGES)\n',
    );
    expect(select(call.arguments, facts, "messages[role=system].content")).toEqual([
      { kind: "string", value: "s" },
    ]);
    expect(select(call.arguments, facts, "messages[0=user].1")).toEqual([
      { kind: "string", value: "u" },
    ]);
    expect(select(call.arguments, facts, "missing|messages[*]")).toHaveLength(2);
  });
});

describe("summarizeText", () => {
  it("joins fixed text and marks dynamic parts", async () => {
    const { facts, call } = await callToF(
      'BASE = "Hi "\ndef greet(name):\n    f(BASE + name + f"!{name}")\n',
    );
    const [value] = select(call.arguments, facts, "#0");
    expect(value === undefined ? null : summarizeText(value, facts)).toMatchObject({
      text: "Hi {name}!{name}",
      dynamic: [
        { text: "name", source: "param" },
        { text: "name", source: "param" },
      ],
    });
  });
});

describe("credentials, environment values and URLs", () => {
  it.each([
    ['f(api_key="sk-k7Qm2xR9vL4pT8wN3bZ6")', "literal"],
    ['f(api_key="sk-1")', "placeholder"],
    ['f(api_key="ollama")', "placeholder"],
    ['f(api_key="sk-your-key-here-0123456789")', "placeholder"],
    ['import os\nf(api_key=os.environ["K"])', "environment"],
    ['import os\nf(api_key=os.getenv("K"))', "environment"],
    ["def g(key):\n    f(api_key=key)", "parameter"],
    ["f()", "default"],
  ])("classifies %s as %s", async (source, expected) => {
    const { facts, call } = await callToF(`${source}\n`);
    expect(credentialOf(select(call.arguments, facts, "api_key"), facts)).toBe(expected);
  });

  it("renders environment reads shell style", async () => {
    const getenv = await callToF('import os\nf(os.getenv("MODEL", "gpt-4o"))\n');
    expect(
      environmentValue(select(getenv.call.arguments, getenv.facts, "#0")[0], getenv.facts),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell-style placeholder
    ).toBe("${MODEL:-gpt-4o}");
    const js = await callToF('f(process.env.MODEL ?? "gpt-4o");\n', "typescript");
    expect(environmentValue(select(js.call.arguments, js.facts, "#0")[0], js.facts)).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell-style placeholder
      "${MODEL:-gpt-4o}",
    );
  });

  it("reads URLs from strings and URL objects", async () => {
    const { facts, call } = await callToF(
      'f(new URL("http://localhost:3000/mcp"));\n',
      "typescript",
    );
    expect(urlString(select(call.arguments, facts, "#0")[0], facts)).toBe(
      "http://localhost:3000/mcp",
    );
  });
});

describe("provenanceOf", () => {
  /** Parameters, call targets and request objects the first argument of `f` comes from. */
  async function traced(source: string, grammar: "python" | "typescript" = "python") {
    const { facts, call } = await callToF(source, grammar);
    const [arg] = call.arguments;
    if (arg === undefined) throw new Error("f has no argument");
    const provenance = provenanceOf(arg.value, facts, call.scope);
    return {
      params: [...provenance.params].sort(),
      calls: [...provenance.calls]
        .map((index) => facts.calls[index]?.ref?.name ?? facts.calls[index]?.callee)
        .sort(),
      requests: [...provenance.requests],
    };
  }

  it("follows a request body through await, members and method calls", async () => {
    const python = await traced(
      'async def h(request):\n    body = await request.json()\n    text = body.get("m") or ""\n    f(text.strip())\n',
    );
    expect(python.params).toEqual(["request"]);
    const js = await traced(
      "export async function POST(req) {\n  const { messages } = await req.json();\n  f(messages.at(-1).content);\n}\n",
      "typescript",
    );
    expect(js.params).toEqual(["req"]);
  });

  it("follows loop variables to what they iterate", async () => {
    const result = await traced(
      "import openai\ndef h():\n    r = openai.OpenAI().chat.completions.create()\n    for call in r.choices[0].message.tool_calls:\n        f(call.function.arguments)\n",
    );
    expect(result.calls).toContain("openai.OpenAI().chat.completions.create");
  });

  it("follows comprehensions, joins and members of call results", async () => {
    const joined = await traced(
      'def h(q, retriever):\n    docs = retriever.invoke(q)\n    f("\\n".join(d.page_content for d in docs))\n',
    );
    expect(joined.params).toEqual(["q", "retriever"]);
    const member = await traced("import requests\ndef h(url):\n    f(requests.get(url).text)\n");
    expect(member).toMatchObject({ params: ["url"], calls: ["requests.get"] });
    const chained = await traced(
      'export function h(docs) {\n  f(docs.map((d) => d.text).join("\\n"));\n}\n',
      "typescript",
    );
    expect(chained.params).toEqual(["docs"]);
  });

  it("names framework request objects and ignores self", async () => {
    const flask = await traced('from flask import request\ndef h():\n    f(request.args["q"])\n');
    expect(flask.requests).toEqual(["flask.request"]);
    const method = await traced("class A:\n    def h(self, q):\n        f(self.base + q)\n");
    expect(method.params).toEqual(["q"]);
  });

  it("does not count the outer function's parameters inside a closure", async () => {
    const result = await traced("def outer(secret):\n    def inner(x):\n        f(secret, x)\n");
    expect(result.params).toEqual([]);
  });
});
