import { readFile } from "node:fs/promises";
import { Language, Parser, type Tree } from "web-tree-sitter";
import { embeddedAsset, isEmbeddedBinary } from "../shared/runtime.ts";
import type { Grammar } from "./languages.ts";

export const GRAMMAR_FILE: Record<Grammar, string> = {
  python: "tree-sitter-python.wasm",
  javascript: "tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
};

let runtime: Promise<void> | undefined;
const languages = new Map<Grammar, Promise<Language>>();

function loadLanguage(grammar: Grammar): Promise<Language> {
  let language = languages.get(grammar);
  if (language === undefined) {
    const name = GRAMMAR_FILE[grammar];
    const bytes = embeddedAsset(`grammars/${name}`);
    language = (
      bytes === undefined
        ? readFile(new URL(`../../grammars/${name}`, import.meta.url))
        : Promise.resolve(bytes)
    ).then((wasm) => Language.load(wasm));
    languages.set(grammar, language);
  }
  return language;
}

/**
 * Parses source text with the bundled tree-sitter grammars. Trees live in WASM
 * memory, so callers must `delete()` every tree they get back.
 */
export class SourceParser {
  readonly #parser: Parser;

  private constructor(parser: Parser) {
    this.#parser = parser;
  }

  static async create(): Promise<SourceParser> {
    runtime ??= Parser.init(
      isEmbeddedBinary ? { wasmBinary: embeddedAsset("runtime/web-tree-sitter.wasm") } : {},
    );
    await runtime;
    return new SourceParser(new Parser());
  }

  async parse(grammar: Grammar, text: string): Promise<Tree> {
    this.#parser.setLanguage(await loadLanguage(grammar));
    const tree = this.#parser.parse(text);
    if (tree === null) throw new Error(`tree-sitter returned no tree for ${grammar} source`);
    return tree;
  }

  dispose(): void {
    this.#parser.delete();
  }
}
