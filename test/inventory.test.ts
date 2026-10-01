import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { scan } from "../src/scan.ts";
import { fixturePath } from "./helpers.ts";
import { type CompactInventory, compact, score } from "./inventory-compact.ts";

describe.each(["frameworks", "crossfile"])("agent inventory on the %s corpus", async (corpus) => {
  const expected: CompactInventory = JSON.parse(
    await readFile(fixturePath(`${corpus}/expected-inventory.json`), "utf8"),
  );
  const actual = compact((await scan(fixturePath(corpus))).inventory);

  it.each(Object.keys(expected))("finds exactly the expected %s", (kind) => {
    expect([...(actual[kind] ?? [])].sort()).toEqual([...(expected[kind] ?? [])].sort());
  });

  it("scores precision and recall of 1 in every section", () => {
    for (const row of score(expected, actual)) {
      expect(row, row.kind).toMatchObject({ precision: 1, recall: 1 });
    }
  });
});

describe("agent inventory details", () => {
  it("never keeps the value of a literal API key", async () => {
    const result = await scan(fixturePath("frameworks/js/rag-graph.ts"));
    expect(JSON.stringify(result.inventory)).not.toContain("sk-ant-test");
    expect(result.inventory.models[0]?.credential).toBe("literal");
  });

  it("reports AI libraries it cannot analyse yet", async () => {
    const result = await scan(fixturePath("frameworks/python/rag_graph.py"));
    expect(result.inventory.unrecognised).toEqual([{ module: "dspy", files: ["rag_graph.py"] }]);
  });

  it("does not mistake the project's own `agents` package for the OpenAI Agents SDK", async () => {
    const result = await scan(fixturePath("local-agents"));
    expect(result.inventory.agents).toEqual([]);
    expect(result.inventory.frameworks.map((framework) => framework.id)).not.toContain(
      "openai-agents",
    );
  });

  it("finds nothing in a project without AI code", async () => {
    const result = await scan(fixturePath("mixed-agent/web/Chat.tsx"));
    expect(compact(result.inventory)).toMatchObject({
      models: [],
      llmCalls: [],
      agents: [],
      tools: [],
    });
  });
});
