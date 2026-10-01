/** A tree-sitter grammar plenger can load. TSX needs its own grammar. */
export type Grammar = "python" | "javascript" | "typescript" | "tsx";

/** The language a file is reported under. */
export type Language = "python" | "javascript" | "typescript";

export const LANGUAGE_OF: Record<Grammar, Language> = {
  python: "python",
  javascript: "javascript",
  typescript: "typescript",
  tsx: "typescript",
};

export const LANGUAGE_LABEL: Record<Language, string> = {
  python: "Python",
  javascript: "JavaScript",
  typescript: "TypeScript",
};

const GRAMMAR_BY_EXTENSION: Record<string, Grammar> = {
  ".py": "python",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
};

/** Source files plenger recognises but does not analyse, and why. */
export type IgnoredSourceReason = "declaration" | "minified";

export type Classification =
  | { kind: "source"; grammar: Grammar }
  | { kind: "ignored"; reason: IgnoredSourceReason }
  | { kind: "other" };

export function classifyPath(path: string): Classification {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  const grammar = dot > 0 ? GRAMMAR_BY_EXTENSION[name.slice(dot)] : undefined;
  if (grammar === undefined) return { kind: "other" };
  if (/\.d\.[mc]?ts$/.test(name)) return { kind: "ignored", reason: "declaration" };
  if (/[.-]min\.[mc]?js$/.test(name)) return { kind: "ignored", reason: "minified" };
  return { kind: "source", grammar };
}
