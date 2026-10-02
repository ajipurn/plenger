import type { Argument, DefinitionFact, FileFacts, Value } from "../facts/model.ts";
import { looksLikeSecret } from "../secrets.ts";
import type { Credential, DynamicPart } from "./model.ts";

const DEREF_DEPTH = 6;

/**
 * Follows a name to the value last assigned to it, when plenger recorded one, or to
 * the constant project linking found in another file.
 */
export function deref(value: Value, facts: FileFacts): Value {
  let current = value;
  for (let depth = 0; depth < DEREF_DEPTH; depth++) {
    if (current.kind !== "name") return current;
    // A constant imported from another project file (`from .prompts import SYSTEM`).
    if (current.ref?.constant !== undefined) return current.ref.constant;
    if (current.assignment === undefined) return current;
    const assignment = facts.assignments[current.assignment];
    // A destructured target holds a member of the value, not the value itself.
    if (assignment === undefined || assignment.member !== undefined) return current;
    current = assignment.value;
  }
  return current;
}

/** Whether an option is present and is not explicitly disabled or empty. */
export function isEnabled(value: Value | undefined, facts: FileFacts): boolean {
  if (value === undefined) return false;
  const target = deref(value, facts);
  if (target.kind === "literal")
    return !/^(?:False|false|None|null|undefined|0)$/.test(target.text);
  if (target.kind === "string") return target.value !== "" && target.value !== "never";
  if (target.kind === "list") return target.items.length > 0 || target.truncated === true;
  if (target.kind === "object") return target.entries.length > 0 || target.truncated === true;
  return true;
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
 * and continues with any of `.key` (object property, list index, or keyword or option
 * of a constructor call), `[*]` (every list item or object value) and `[key=value]`
 * (list items whose property or index `key` is the string `value`). Names are followed
 * to their assigned values at every step.
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
      current = property(deref(positional[0].value, facts), head, facts);
  }

  for (const step of rest.matchAll(/\.([\w$#]+)|\[([^\]]*)\]/g)) {
    const key = step[1];
    const filter = step[2];
    current = current.flatMap((value) => {
      const target = deref(value, facts);
      if (key !== undefined) return property(target, key, facts);
      if (filter === "*" && target.kind === "object")
        return target.entries.map((entry) => entry.value);
      if (target.kind !== "list") return [];
      if (filter === "*") return target.items;
      const [field, expected] = (filter ?? "").split("=");
      return target.items.filter((item) => {
        const [found] = property(deref(item, facts), field ?? "", facts);
        const resolved = found === undefined ? undefined : deref(found, facts);
        return resolved?.kind === "string" && resolved.value === expected;
      });
    });
  }
  return current;
}

/** A property of an object, an item of a list, or a keyword or option of a constructor call. */
function property(value: Value, key: string, facts: FileFacts, depth = 0): Value[] {
  if (value.kind === "call") {
    // `Message(content=x)`, `GenerateContentConfig(system_instruction=...)`, `new Command({ ... })`
    const args = facts.calls[value.call]?.arguments ?? [];
    const keyword = args.find((arg) => arg.keyword === key);
    if (keyword !== undefined) return [keyword.value];
    const first = args.find((arg) => arg.keyword === null && !arg.spread);
    // `app = wrap(app)` refers to itself; give up after a few calls.
    if (first === undefined || depth >= DEREF_DEPTH) return [];
    return property(deref(first.value, facts), key, facts, depth + 1);
  }
  if (value.kind === "object") {
    return value.entries.filter((entry) => entry.key === key).map((entry) => entry.value);
  }
  if (value.kind === "list" && /^\d+$/.test(key)) {
    const item = value.items[Number(key)];
    return item === undefined ? [] : [item];
  }
  return [];
}

/** Where a value comes from, traced within one file. */
export interface Provenance {
  /** Parameters of the function the value is evaluated in (never `self` or `cls`). */
  params: Set<string>;
  /** Calls (indices into `FileFacts.calls`) whose results the value is computed from. */
  calls: Set<number>;
  /** Request objects of web frameworks that are module globals (`flask.request`). */
  requests: Set<string>;
}

const PROVENANCE_DEPTH = 8;
const REQUEST_GLOBAL = /^((?:flask|quart|bottle)\.request)(?:\.|\(|$)/;
const RECEIVER = /^(?:self|cls)$/;
const IDENTIFIER = /(?<![\w$.])[A-Za-z_$][\w$]*/g;

const definitionIndex = new WeakMap<FileFacts, Map<string, DefinitionFact>>();

/** A definition of the file by id. */
export function definitionOf(facts: FileFacts, id: string | null): DefinitionFact | undefined {
  if (id === null) return undefined;
  let index = definitionIndex.get(facts);
  if (index === undefined) {
    index = new Map(facts.definitions.map((definition) => [definition.id, definition]));
    definitionIndex.set(facts, index);
  }
  return index.get(id);
}

/** Parameters of a function that callers fill in: all but a method's `self` or `cls`. */
export function paramsOf(facts: FileFacts, scope: string | null): Set<string> {
  const params = definitionOf(facts, scope)?.params ?? [];
  return new Set(params.filter((param) => !RECEIVER.test(param)));
}

/**
 * Traces a value back through variables (loop variables included), calls (their
 * receivers and arguments) and string building to the parameters, calls and request
 * objects it is computed from. Over-approximates: a call's result is taken to depend
 * on everything passed to it.
 */
export function provenanceOf(value: Value, facts: FileFacts, scope: string | null): Provenance {
  const params = paramsOf(facts, scope);
  const result: Provenance = { params: new Set(), calls: new Set(), requests: new Set() };
  const seen = new Set<string>();
  const request = (name: string | undefined) => {
    const match = name === undefined ? null : REQUEST_GLOBAL.exec(name);
    if (match !== null) result.requests.add(match[1] as string);
  };
  const assignment = (index: number, depth: number) => {
    if (seen.has(`a${index}`)) return;
    seen.add(`a${index}`);
    const fact = facts.assignments[index];
    if (fact !== undefined) visit(fact.value, fact.scope, depth + 1);
  };
  // Parameters count only in the function the value is evaluated in, not in a closure's outer function.
  const visit = (current: Value, here: string | null, depth: number): void => {
    if (depth > PROVENANCE_DEPTH) return;
    const local = here === scope;
    switch (current.kind) {
      case "name": {
        request(current.ref?.name);
        const root = /^[\w$]+/.exec(current.text)?.[0] ?? "";
        if (current.param) {
          if (local && params.has(root)) result.params.add(root);
        } else if (current.assignment !== undefined) {
          assignment(current.assignment, depth);
        } else if (current.base !== undefined) {
          assignment(current.base, depth);
        }
        if (current.of !== undefined) visit({ kind: "call", call: current.of }, here, depth + 1);
        return;
      }
      case "call": {
        if (seen.has(`c${current.call}`)) return;
        seen.add(`c${current.call}`);
        result.calls.add(current.call);
        const call = facts.calls[current.call];
        if (call === undefined) return;
        request(call.ref?.name);
        const root = /^[\w$]+/.exec(call.callee)?.[0] ?? "";
        if (call.scope === scope && params.has(root)) result.params.add(root);
        if (call.receiver !== undefined) assignment(call.receiver, depth);
        for (const arg of call.arguments) visit(arg.value, call.scope, depth + 1);
        // A chained call (`docs.map(...).join()`) is computed from the calls before it.
        for (const index of chainOf(facts, current.call))
          visit({ kind: "call", call: index }, call.scope, depth + 1);
        return;
      }
      case "string":
        for (const part of current.template ?? []) visit(part, here, depth + 1);
        return;
      case "concat":
        for (const part of current.parts) visit(part, here, depth + 1);
        return;
      case "list":
        for (const item of current.items) visit(item, here, depth + 1);
        return;
      case "object":
        for (const entry of current.entries) visit(entry.value, here, depth + 1);
        return;
      case "other":
        if (current.parts !== undefined) {
          for (const part of current.parts) visit(part, here, depth + 1);
        } else if (local) {
          // Expressions plenger keeps only as text: any parameter named in them.
          for (const match of current.text.matchAll(IDENTIFIER))
            if (params.has(match[0])) result.params.add(match[0]);
        }
        return;
      default:
        return;
    }
  };
  visit(value, scope, 0);
  return result;
}

const chains = new WeakMap<FileFacts, Map<string, number[]>>();

/** Calls that start where a call starts and end before it: the earlier links of its chain. */
function chainOf(facts: FileFacts, index: number): number[] {
  let byStart = chains.get(facts);
  if (byStart === undefined) {
    byStart = new Map();
    facts.calls.forEach((call, position) => {
      const key = `${call.span.line}:${call.span.column}`;
      const list = byStart?.get(key) ?? [];
      list.push(position);
      byStart?.set(key, list);
    });
    chains.set(facts, byStart);
  }
  const call = facts.calls[index];
  if (call === undefined) return [];
  const end = call.span.endLine * 1e6 + call.span.endColumn;
  return (byStart.get(`${call.span.line}:${call.span.column}`) ?? []).filter((other) => {
    const span = facts.calls[other]?.span;
    return span !== undefined && span.endLine * 1e6 + span.endColumn < end;
  });
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

/**
 * Summarises a string-like value: fixed text, with dynamic parts as `{expression}`.
 * `scope` is the function the value is evaluated in, for tracing dynamic parts.
 */
export function summarizeText(
  value: Value,
  facts: FileFacts,
  scope: string | null = null,
): TextSummary | null {
  const origin = originOf(value, facts);
  const summary: TextSummary = { text: "", dynamic: [], truncated: false, fixed: [], origin };
  return appendText(summary, value, facts, scope, 0) ? summary : null;
}

function appendText(
  summary: TextSummary,
  value: Value,
  facts: FileFacts,
  scope: string | null,
  depth: number,
): boolean {
  const target = depth < DEREF_DEPTH ? deref(value, facts) : value;
  // A constant from another variable is evaluated where that variable was assigned.
  const here =
    target === value || value.kind !== "name" || value.assignment === undefined
      ? scope
      : (facts.assignments[value.assignment]?.scope ?? scope);
  switch (target.kind) {
    case "string": {
      summary.text += target.value;
      summary.fixed.push(target.value);
      if (target.truncated) summary.truncated = true;
      for (const part of target.template ?? [])
        summary.dynamic.push(dynamicPart(part, facts, here));
      return true;
    }
    case "concat":
      for (const part of target.parts) {
        if (!appendText(summary, part, facts, here, depth + 1)) {
          const dynamic = dynamicPart(part, facts, here);
          summary.text += `{${dynamic.text}}`;
          summary.dynamic.push(dynamic);
        }
      }
      return true;
    case "name":
    case "call": {
      if (depth > 0) return false;
      const dynamic = dynamicPart(value, facts, scope);
      summary.text += `{${dynamic.text}}`;
      summary.dynamic.push(dynamic);
      return true;
    }
    default:
      return false;
  }
}

/** A dynamic part, traced back to the parameters of `scope` and request objects it comes from. */
export function dynamicPart(
  value: Value,
  facts: FileFacts,
  scope: string | null = null,
): DynamicPart {
  let part: DynamicPart;
  switch (value.kind) {
    case "name":
      part = { text: value.text, source: value.param ? "param" : "name" };
      if (value.ref !== null) part.ref = value.ref.name;
      break;
    case "call": {
      const call = facts.calls[value.call];
      part = { text: `${call?.callee ?? ""}()`, source: "call" };
      if (call?.ref) part.ref = call.ref.name;
      break;
    }
    case "string":
      part = { text: value.value, source: "other" };
      break;
    case "other":
    case "literal":
      part = { text: value.text, source: "other" };
      break;
    default:
      part = { text: value.kind, source: "other" };
  }
  const provenance = provenanceOf(value, facts, scope);
  const from = [...provenance.params, ...provenance.requests];
  if (from.length > 0) part.from = from;
  const calls: string[] = [];
  const sites: string[] = [];
  for (const index of provenance.calls) {
    const call = facts.calls[index];
    const name = call?.ref?.name;
    if (call === undefined || name === undefined || calls.length >= MAX_TRACED_CALLS) continue;
    calls.push(name);
    sites.push(`${call.span.line}:${call.span.column}`);
  }
  if (calls.length > 0) {
    part.calls = calls;
    part.callSites = sites;
  }
  return part;
}

const MAX_TRACED_CALLS = 8;

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
      if (target.template !== undefined || target.value === "") return "other";
      return looksLikeSecret(target.value) ? "literal" : "placeholder";
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
