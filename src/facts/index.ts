import type { Node, Tree } from "web-tree-sitter";
import { byFamily, type Grammar, LANGUAGE_OF, type LanguageFamily } from "../source/languages.ts";
import { extractJavaScript } from "./javascript.ts";
import type { FileFacts } from "./model.ts";
import { extractPhp } from "./php.ts";
import { extractPython } from "./python.ts";

export type * from "./model.ts";

const EXTRACTORS: Record<LanguageFamily, (root: Node) => FileFacts> = {
  python: extractPython,
  javascript: extractJavaScript,
  php: extractPhp,
};

export function extractFacts(tree: Tree, grammar: Grammar): FileFacts {
  return byFamily(LANGUAGE_OF[grammar], EXTRACTORS)(tree.rootNode);
}
