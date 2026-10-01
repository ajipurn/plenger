import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Grammar } from "../src/languages.ts";
import { GRAMMAR_FILE, SourceParser } from "../src/parser.ts";

const grammarDir = new URL("../grammars/", import.meta.url);

describe("bundled grammars", () => {
  it("match the checksums recorded by scripts/update-grammars.ts", async () => {
    const manifest: Record<string, { file: string; sha256: string }> = JSON.parse(
      await readFile(new URL("manifest.json", grammarDir), "utf8"),
    );
    expect(Object.keys(manifest).sort()).toEqual(Object.keys(GRAMMAR_FILE).sort());
    for (const [grammar, entry] of Object.entries(manifest)) {
      expect(entry.file).toBe(GRAMMAR_FILE[grammar as Grammar]);
      const digest = createHash("sha256")
        .update(await readFile(new URL(entry.file, grammarDir)))
        .digest("hex");
      expect(digest, grammar).toBe(entry.sha256);
    }
  });
});

describe("SourceParser", () => {
  let parser: SourceParser;

  beforeAll(async () => {
    parser = await SourceParser.create();
  });

  afterAll(() => {
    parser.dispose();
  });

  it.each<[Grammar, string, string]>([
    ["python", "@tool\ndef run(cmd: str) -> str:\n    return cmd\n", "module"],
    ["javascript", "const t = tool({ execute: async () => 1 });\n", "program"],
    ["typescript", "const s: Server = new Server({ name: 'x' });\n", "program"],
    ["tsx", "export const A = (p: { x: string }) => <div>{p.x}</div>;\n", "program"],
  ])("parses valid %s", async (grammar, source, rootType) => {
    const tree = await parser.parse(grammar, source);
    try {
      expect(tree.rootNode.type).toBe(rootType);
      expect(tree.rootNode.hasError).toBe(false);
    } finally {
      tree.delete();
    }
  });

  it.each<[Grammar, string]>([
    ["python", "def broken(:\n"],
    ["typescript", "const = ;\n"],
  ])("flags syntax errors in %s", async (grammar, source) => {
    const tree = await parser.parse(grammar, source);
    try {
      expect(tree.rootNode.hasError).toBe(true);
    } finally {
      tree.delete();
    }
  });

  it("parses TSX with the TSX grammar, not the TypeScript one", async () => {
    const source = "const el = <div>{x}</div>;\n";
    const tsx = await parser.parse("tsx", source);
    const ts = await parser.parse("typescript", source);
    try {
      expect(tsx.rootNode.hasError).toBe(false);
      expect(ts.rootNode.hasError).toBe(true);
    } finally {
      tsx.delete();
      ts.delete();
    }
  });
});
