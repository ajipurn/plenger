import type { Tree } from "web-tree-sitter";
import type { Grammar } from "../languages.ts";
import { extractJavaScript } from "./javascript.ts";
import type { FileFacts } from "./model.ts";
import { extractPython } from "./python.ts";

export type * from "./model.ts";

export function extractFacts(tree: Tree, grammar: Grammar): FileFacts {
  return grammar === "python" ? extractPython(tree.rootNode) : extractJavaScript(tree.rootNode);
}
