import { expect } from "vitest";
import { extractFacts } from "../src/facts/index.ts";
import type { CallFact, DefinitionFact, FileFacts, Value } from "../src/facts/model.ts";
import { scan } from "../src/scan.ts";
import type { Grammar } from "../src/source/languages.ts";
import { SourceParser } from "../src/source/parser.ts";
import { fixturePath } from "./support/fixtures.ts";

export { fixturePath };

/** Facts for one fixture file, extracted through the source parser. */
export async function factsOfFixture(relative: string): Promise<FileFacts> {
  const result = await scan(fixturePath(relative), { facts: true });
  const facts = result.files[0]?.facts;
  if (facts === undefined) throw new Error(`no facts for ${relative}`);
  return facts;
}

export async function factsOf(grammar: Grammar, source: string): Promise<FileFacts> {
  const parser = await SourceParser.create();
  const tree = await parser.parse(grammar, source);
  try {
    return extractFacts(tree, grammar);
  } finally {
    tree.delete();
    parser.dispose();
  }
}

/** Every call whose resolved target is `name`. */
export function callsTo(facts: FileFacts, name: string): CallFact[] {
  return facts.calls.filter((call) => call.ref?.name === name);
}

/** The single call whose resolved target is `name`. */
export function callTo(facts: FileFacts, name: string): CallFact {
  const calls = callsTo(facts, name);
  expect(calls, `calls to ${name}`).toHaveLength(1);
  return calls[0] as CallFact;
}

export function definition(facts: FileFacts, id: string): DefinitionFact {
  const found = facts.definitions.find((candidate) => candidate.id === id);
  expect(found, `definition ${id}`).toBeDefined();
  return found as DefinitionFact;
}

export function argument(call: CallFact, keyword: string | number): Value {
  const found =
    typeof keyword === "number"
      ? call.arguments.filter((arg) => arg.keyword === null)[keyword]
      : call.arguments.find((arg) => arg.keyword === keyword);
  expect(found, `argument ${keyword} of ${call.callee}`).toBeDefined();
  return (found as { value: Value }).value;
}

/** An object literal's entry by key. */
export function entry(value: Value | undefined, key: string): Value {
  expect(value?.kind).toBe("object");
  const found =
    value?.kind === "object" ? value.entries.find((item) => item.key === key) : undefined;
  expect(found, `entry ${key}`).toBeDefined();
  return (found as { value: Value }).value;
}

/** The value assigned to the variable a name value points at. */
export function assigned(facts: FileFacts, value: Value | undefined): Value {
  expect(value?.kind).toBe("name");
  const index = value?.kind === "name" ? value.assignment : undefined;
  expect(index, "name links to an assignment").toBeDefined();
  return facts.assignments[index as number]?.value as Value;
}

export function refName(value: Value | undefined): string | null | undefined {
  return value?.kind === "name" ? value.ref?.name : undefined;
}
