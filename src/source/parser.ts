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
 * Other ways to parse a JavaScript or TSX file the grammar rejects, each keeping every
 * position: the TSX grammar, which accepts keywords as JSX names (`<Skeleton.default>`,
 * `<feBlend in="...">`) and `import ... assert { type: "json" }`, and both grammars with
 * each bare `&` in JSX text or attributes (`Reject & close`, `?a=1&b=2`) read as `+`.
 * Neither grammar accepts a bare `&`; React does. `rejected` is the first tree.
 */
function jsxRepairs(grammar: Grammar, text: string, rejected: Tree): [Grammar, string][] {
  const ampersands = ampersandsInJsx(text, rejected);
  const repairs: [Grammar, string][] = grammar === "javascript" ? [["tsx", text]] : [];
  if (ampersands !== text) {
    if (grammar === "javascript") repairs.push(["javascript", ampersands]);
    repairs.push(["tsx", ampersands]);
  }
  return repairs;
}

/**
 * `text` with each bare `&` read as `+` where JSX may hold one: in JSX text, in a JSX
 * attribute's string, and in code the grammar rejected. String literals, comments and
 * operators elsewhere keep theirs, so the facts read from them match the file.
 */
function ampersandsInJsx(text: string, rejected: Tree): string {
  const ranges = rejected.rootNode
    .descendantsOfType(["ERROR", "jsx_text", "string"])
    .filter(
      (node) => node !== null && (node.type !== "string" || node.parent?.type === "jsx_attribute"),
    )
    .map((node) => [node?.startIndex ?? 0, node?.endIndex ?? 0] as const);
  return text.replace(/(?<![&=|])&(?![&=]|#?\w+;)/g, (match, offset: number) =>
    ranges.some(([from, to]) => offset >= from && offset < to) ? "+" : match,
  );
}

function errorCount(tree: Tree): number {
  return tree.rootNode.descendantsOfType("ERROR").length + (tree.rootNode.hasError ? 1 : 0);
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
   * A JavaScript or TSX file with syntax errors is parsed again with the repairs in
   * `jsxRepairs`, keeping the tree with the fewest errors.
   */
  async parse(grammar: Grammar, text: string): Promise<Tree> {
    let best = await this.#parse(grammar, text);
    if (!best.rootNode.hasError || (grammar !== "javascript" && grammar !== "tsx")) return best;
    let errors = errorCount(best);
    for (const [repair, source] of jsxRepairs(grammar, text, best)) {
      const tree = await this.#parse(repair, source);
      const count = errorCount(tree);
      if (count < errors) {
        best.delete();
        best = tree;
        errors = count;
      } else tree.delete();
      if (errors === 0) break;
    }
    return best;
  }

  async #parse(grammar: Grammar, text: string): Promise<Tree> {
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
