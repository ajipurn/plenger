import { readFile } from "node:fs/promises";
import { Language, Parser, type Tree } from "web-tree-sitter";
import type { Grammar } from "./languages.ts";
import { maskTypeOnlySyntax } from "./typescript-syntax.ts";

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
    language = readFile(new URL(`../../grammars/${GRAMMAR_FILE[grammar]}`, import.meta.url)).then(
      (wasm) => Language.load(wasm),
    );
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
    runtime ??= Parser.init();
    await runtime;
    return new SourceParser(new Parser());
  }

  /**
   * Parses `text`. For TypeScript and TSX, type-only syntax the grammar does not know is
   * blanked first (see `maskTypeOnlySyntax`); positions in the tree stay those of `text`.
   */
  async parse(grammar: Grammar, text: string): Promise<Tree> {
    this.#parser.setLanguage(await loadLanguage(grammar));
    const source = grammar === "typescript" || grammar === "tsx" ? maskTypeOnlySyntax(text) : text;
    const tree = this.#parser.parse(source);
    if (tree === null) throw new Error(`tree-sitter returned no tree for ${grammar} source`);
    return tree;
  }

  dispose(): void {
    this.#parser.delete();
  }
}
