import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Grammar } from "../src/source/languages.ts";
import { GRAMMAR_FILE, SourceParser } from "../src/source/parser.ts";
import { maskTypeOnlySyntax } from "../src/source/typescript-syntax.ts";

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

describe("TypeScript 5 type syntax the grammar does not know", () => {
  let parser: SourceParser;

  beforeAll(async () => {
    parser = await SourceParser.create();
  });

  afterAll(() => {
    parser.dispose();
  });

  it.each([
    ['export type * from "./model.ts";\nexport const a = 1;\n'],
    ['export type * as Model from "./model.ts";\n'],
    ['type A = import("./x").T[];\nlet b: import("./x").Item<string>[][] = [];\n'],
    ["interface Box<in out T> { value: T }\nclass Sink<in T, out U extends string> {}\n"],
    [
      "export declare abstract class Reader<out T = () => void> {}\ntype F<in A> = (a: A) => void;\n",
    ],
  ])("parses %j without errors", async (source) => {
    for (const grammar of ["typescript", "tsx"] as const) {
      const tree = await parser.parse(grammar, source);
      try {
        expect(tree.rootNode.hasError, grammar).toBe(false);
      } finally {
        tree.delete();
      }
    }
  });

  it("keeps lengths, line breaks and runtime code as they are", () => {
    const source = [
      'export type * from "./model.ts"; // 🙂',
      "interface Box<in out T> { value: T }",
      'const text = "class A<in B> {}";',
      "for (const key in table) use(key);",
      "type Named<out> = out;",
      "const modules = [import('./a')];",
    ].join("\n");
    const masked = maskTypeOnlySyntax(source);
    expect(masked).toHaveLength(source.length);
    expect(masked.split("\n").map((line) => line.trimEnd())).toEqual([
      "                                 // 🙂",
      "interface Box<       T> { value: T }",
      'const text = "class A<in B> {}";',
      "for (const key in table) use(key);",
      "type Named<out> = out;",
      "const modules = [import('./a')];",
    ]);
  });
});
