import type { Argument, FileFacts, Value } from "../facts/model.ts";
import type { Credential, DynamicPart } from "./model.ts";

const DEREF_DEPTH = 6;

/** Follows a name to the value last assigned to it, when plenger recorded one. */
export function deref(value: Value, facts: FileFacts): Value {
  let current = value;
  for (let depth = 0; depth < DEREF_DEPTH; depth++) {
    if (current.kind !== "name" || current.assignment === undefined) return current;
    const assignment = facts.assignments[current.assignment];
    // A destructured target holds a member of the value, not the value itself.
    if (assignment === undefined || assignment.member !== undefined) return current;
    current = assignment.value;
  }
  return current;
}

/** The assignment a value was read from, when it is a name plenger can follow. */
export function originOf(value: Value, facts: FileFacts): number | null {
  if (value.kind !== "name" || value.assignment === undefined) return null;
  const assignment = facts.assignments[value.assignment];
  return assignment === undefined || assignment.member !== undefined ? null : value.assignment;
}

/**
 * Selects values from call arguments. A path is one or more alternatives separated
 * by `|`; the first alternative that yields anything wins. Each alternative starts with
 *
 * - `name`: keyword argument `name`, or property `name` of the first positional
 *   object (the options object most JS APIs take)
 * - `#N`: positional argument N, `#-1` for the last one
 *
 * and continues with any of `.key` (object property or list index), `[*]` (every list
 * item or object value) and `[key=value]` (list items whose property or index `key`
 * is the string `value`). Names are followed to their assigned values at every step.
 */
export function select(args: Argument[] | null, facts: FileFacts, path: string): Value[] {
  if (args === null) return [];
  for (const alternative of path.split("|")) {
    const values = selectOne(args, facts, alternative.trim());
    if (values.length > 0) return values;
  }
  return [];
}

function selectOne(args: Argument[], facts: FileFacts, path: string): Value[] {
  const match = /^(#-?\d+|[\w$]+)(.*)$/.exec(path);
  if (match === null) throw new Error(`bad argument path: ${path}`);
  const head = match[1] as string;
  const rest = match[2] as string;
  const positional = args.filter((arg) => arg.keyword === null && !arg.spread);

  let current: Value[] = [];
  if (head.startsWith("#")) {
    const index = Number(head.slice(1));
    const arg = positional[index < 0 ? positional.length + index : index];
    if (arg !== undefined) current = [arg.value];
  } else {
    const keyword = args.find((arg) => arg.keyword === head);
    if (keyword !== undefined) current = [keyword.value];
    else if (positional[0] !== undefined)
      current = property(deref(positional[0].value, facts), head);
  }

  for (const step of rest.matchAll(/\.([\w$#]+)|\[([^\]]*)\]/g)) {
    const key = step[1];
    const filter = step[2];
    current = current.flatMap((value) => {
      const target = deref(value, facts);
      if (key !== undefined) return property(target, key);
      if (filter === "*" && target.kind === "object")
        return target.entries.map((entry) => entry.value);
      if (target.kind !== "list") return [];
      if (filter === "*") return target.items;
      const [field, expected] = (filter ?? "").split("=");
      return target.items.filter((item) => {
        const [found] = property(deref(item, facts), field ?? "");
        const resolved = found === undefined ? undefined : deref(found, facts);
        return resolved?.kind === "string" && resolved.value === expected;
      });
    });
  }
  return current;
}

function property(value: Value, key: string): Value[] {
  if (value.kind === "object") {
    return value.entries.filter((entry) => entry.key === key).map((entry) => entry.value);
  }
  if (value.kind === "list" && /^\d+$/.test(key)) {
    const item = value.items[Number(key)];
    return item === undefined ? [] : [item];
  }
  return [];
}

export interface TextSummary {
  text: string;
  dynamic: DynamicPart[];
  truncated: boolean;
  /** Fixed text segments, for finding template variables. */
  fixed: string[];
  /** Assignment the whole text was read from, if any. */
  origin: number | null;
}

/** Summarises a string-like value: fixed text, with dynamic parts as `{expression}`. */
export function summarizeText(value: Value, facts: FileFacts): TextSummary | null {
  const origin = originOf(value, facts);
  const summary: TextSummary = { text: "", dynamic: [], truncated: false, fixed: [], origin };
  return appendText(summary, value, facts, 0) ? summary : null;
}

function appendText(summary: TextSummary, value: Value, facts: FileFacts, depth: number): boolean {
  const target = depth < DEREF_DEPTH ? deref(value, facts) : value;
  switch (target.kind) {
    case "string": {
      summary.text += target.value;
      summary.fixed.push(target.value);
      if (target.truncated) summary.truncated = true;
      for (const part of target.template ?? []) summary.dynamic.push(dynamicPart(part, facts));
      return true;
    }
    case "concat":
      for (const part of target.parts) {
        if (!appendText(summary, part, facts, depth + 1)) {
          const dynamic = dynamicPart(part, facts);
          summary.text += `{${dynamic.text}}`;
          summary.dynamic.push(dynamic);
        }
      }
      return true;
    case "name":
    case "call": {
      if (depth > 0) return false;
      const dynamic = dynamicPart(value, facts);
      summary.text += `{${dynamic.text}}`;
      summary.dynamic.push(dynamic);
      return true;
    }
    default:
      return false;
  }
}

export function dynamicPart(value: Value, facts: FileFacts): DynamicPart {
  switch (value.kind) {
    case "name": {
      const part: DynamicPart = { text: value.text, source: value.param ? "param" : "name" };
      if (value.ref !== null) part.ref = value.ref.name;
      return part;
    }
    case "call": {
      const call = facts.calls[value.call];
      const part: DynamicPart = { text: `${call?.callee ?? ""}()`, source: "call" };
      if (call?.ref) part.ref = call.ref.name;
      return part;
    }
    case "string":
      return { text: value.value, source: "other" };
    case "other":
    case "literal":
      return { text: value.text, source: "other" };
    default:
      return { text: value.kind, source: "other" };
  }
}

/** A fixed string, following names to their assigned values. */
export function literalString(value: Value | undefined, facts: FileFacts): string | null {
  if (value === undefined) return null;
  const target = deref(value, facts);
  return target.kind === "string" && target.template === undefined ? target.value : null;
}

/**
 * A value read from the environment, shell style: `$NAME`, or `${NAME:-default}` when
 * `os.getenv("NAME", "default")` gives a fallback. Null for anything else.
 */
export function environmentValue(value: Value | undefined, facts: FileFacts): string | null {
  if (value === undefined) return null;
  const target = deref(value, facts);
  if (target.kind === "other") {
    // `process.env.MODEL ?? "gpt-4o"` and `os.getenv("MODEL") or "gpt-4o"`
    const fallback =
      /^process\.env\.([\w$]+)\s*(?:\?\?|\|\|)\s*["'`]([^"'`]*)["'`]$/.exec(target.text) ??
      /^os\.(?:getenv|environ\.get)\(\s*["'](\w+)["']\s*\)\s+or\s+["']([^"']*)["']$/.exec(
        target.text,
      );
    return fallback === null ? null : `\${${fallback[1]}:-${fallback[2]}}`;
  }
  if (target.kind === "name" && target.ref !== null) {
    const match = /^(?:os\.environ|process\.env|import\.meta\.env)\.([\w$]+)$/.exec(
      target.ref.name,
    );
    return match === null ? null : `$${match[1]}`;
  }
  if (target.kind !== "call") return null;
  const call = facts.calls[target.call];
  if (!/^os\.(?:getenv|environ\.get)$/.test(call?.ref?.name ?? "")) return null;
  const name = literalString(select(call?.arguments ?? null, facts, "key|#0")[0], facts);
  const fallback = literalString(select(call?.arguments ?? null, facts, "default|#1")[0], facts);
  if (name === null) return null;
  return fallback === null ? `$${name}` : `\${${name}:-${fallback}}`;
}

/** A URL given as a string or as `new URL("...")`. */
export function urlString(value: Value | undefined, facts: FileFacts): string | null {
  const text = literalString(value, facts);
  if (text !== null || value === undefined) return text;
  const target = deref(value, facts);
  if (target.kind !== "call" || facts.calls[target.call]?.ref?.name !== "URL") return null;
  return literalString(select(facts.calls[target.call]?.arguments ?? null, facts, "#0")[0], facts);
}

const ENVIRONMENT = /^(?:os\.environ|os\.getenv|process\.env|import\.meta\.env|Deno\.env)/;

/** Where a credential argument comes from. The value itself is never kept. */
export function credentialOf(values: Value[], facts: FileFacts): Credential {
  const [value] = values;
  if (value === undefined) return "default";
  const target = deref(value, facts);
  switch (target.kind) {
    case "string":
      return target.template === undefined && target.value !== "" ? "literal" : "other";
    case "name":
      if (target.param) return "parameter";
      return target.ref !== null && ENVIRONMENT.test(target.ref.name) ? "environment" : "other";
    case "call": {
      const name = facts.calls[target.call]?.ref?.name ?? "";
      return ENVIRONMENT.test(name) ? "environment" : "other";
    }
    default:
      return "other";
  }
}
