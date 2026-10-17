/**
 * tree-sitter-typescript 0.23.2, the grammar's last release, rejects some TypeScript 5
 * type syntax. None of it does anything at run time, so the parser gets spaces in its
 * place, which keeps every other offset, line and column:
 *
 * - `export type * from "./m"` and `export type * as Ns from "./m"`
 * - type arguments and array brackets after an import type: `import("./m").T<U>[]`
 * - `in` and `out` variance modifiers: `interface Box<in out T>`
 */
export function maskTypeOnlySyntax(text: string): string {
  if (!/\btype\s*\*|\bimport\s*\(|<[^<>]*\b(?:in|out)\s/.test(text)) return text;
  let masked = text.replace(TYPE_STAR_EXPORT, blank);
  masked = masked.replace(IMPORT_TYPE_SUFFIX, (match: string, ...groups: unknown[]) => {
    const suffix = groups[1] as string;
    return match.slice(0, match.length - suffix.length) + blank(suffix);
  });
  return maskVariance(masked);
}

const TYPE_STAR_EXPORT =
  /^[ \t]*export\s+type\s+\*(?:\s+as\s+[\w$]+)?\s+from\s+(["'])[^"'\n]*\1[ \t]*;?/gm;
const IMPORT_TYPE_SUFFIX =
  /\bimport\s*\(\s*(["'])[^"'\n]*\1\s*\)(?:\s*\.\s*[\w$]+)+((?:<(?:[^<>\n]|<[^<>\n]*>)*>)?(?:\s*\[\s*\])*)/g;
/** Declarations whose type parameters can carry variance modifiers, at the start of a line. */
const VARIANCE_OWNER =
  /^[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:interface|class|type)\s+[\w$]+\s*</gm;

/** Spaces in place of every character but line breaks. */
function blank(text: string): string {
  return text.replace(/[^\r\n]/g, " ");
}

/** Blanks `in` and `out` where they start a type parameter of an interface, class or type alias. */
function maskVariance(text: string): string {
  // UTF-16 code units, the same indices `text[index]` uses.
  const chars = text.split("");
  for (const match of text.matchAll(VARIANCE_OWNER)) {
    let depth = 0;
    let start = true;
    for (let index = (match.index ?? 0) + match[0].length - 1; index < text.length; index++) {
      const char = text[index];
      if (char === "=" && text[index + 1] === ">") {
        index++;
        continue;
      }
      if (char === "<") depth++;
      else if (char === ">") {
        depth--;
        if (depth === 0) break;
      } else if (char === "," && depth === 1) start = true;
      else if (/\s/.test(char ?? "")) continue;
      else if (start && depth === 1) {
        // `in out T`: each modifier is followed by another word that is not `extends`.
        const modifier = /^(?:in|out)(?=\s+(?!extends\b)[A-Za-z_$])/.exec(text.slice(index));
        if (modifier !== null) {
          for (let offset = 0; offset < modifier[0].length; offset++) chars[index + offset] = " ";
          index += modifier[0].length - 1;
          continue;
        }
        start = false;
      }
      if (char === "<" && depth === 1) start = true;
    }
  }
  return chars.join("");
}
