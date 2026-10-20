/**
 * Patterns over canonical names (see `Ref.name`):
 *
 * - `{a,b,}` matches one of the alternatives (an empty one is allowed); alternatives
 *   may use `*` and `**` but not nested braces
 * - `*` matches one name segment: anything but `.`, `(`, `#` and `/`
 * - `**` matches anything, including nothing
 *
 * Everything else is literal, so `openai.*().chat.completions.{create,parse}` matches
 * `openai.AsyncOpenAI().chat.completions.create`. A name that matches one of `except`
 * matches none.
 */
export function compilePatterns(
  patterns: readonly string[],
  except: readonly string[] = [],
): RegExp {
  const excluded = except.length === 0 ? "" : `(?!(?:${except.map(patternSource).join("|")})$)`;
  return new RegExp(`^${excluded}(?:${patterns.map(patternSource).join("|")})$`);
}

function patternSource(pattern: string): string {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^.(#/]*";
      }
    } else if (char === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) throw new Error(`unclosed { in pattern ${pattern}`);
      source += `(?:${pattern
        .slice(i + 1, end)
        .split(",")
        .map(patternSource)
        .join("|")})`;
      i = end;
    } else {
      source += escapeRegex(char);
    }
  }
  return source;
}

function escapeRegex(text: string): string {
  return text.replace(/[\\^$.|?*+()[\]{}/]/g, "\\$&");
}
