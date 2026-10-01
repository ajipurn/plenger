import { describe, expect, it } from "vitest";
import {
  credentialOf,
  environmentValue,
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
    ['f(api_key="sk-1")', "literal"],
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
