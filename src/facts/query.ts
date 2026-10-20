/**
 * Queries over the code facts of one file: following names to their values, selecting
 * call arguments by path, summarising string building and tracing where values come
 * from. Everything here is file-local; project linking supplies cross-file constants.
 */

import { looksLikeSecret } from "../shared/secrets.ts";
import type { Argument, CallFact, DefinitionFact, FileFacts, Value } from "./model.ts";

const DEREF_DEPTH = 6;

/** A part of a prompt or input that is not fixed text. */
export interface DynamicPart {
  /** The expression as written. */
  text: string;
  /** `param`: a parameter of the enclosing function, the usual way outside input arrives. */
  source: "param" | "name" | "call" | "other";
  /** Resolved target, when there is one (`ai#generateText().text`, `os.getenv`). */
  ref?: string;
  /**
   * Where the value comes from, as far as plenger can trace it through variables, calls
   * and string building: parameters of the enclosing function (`body` from
   * `await req.json()` comes from `req`), and request objects of web frameworks
   * (`flask.request`).
   */
  from?: string[];
  /** Canonical names of the calls the value is computed from (`openai.OpenAI().chat.completions.create`). */
  calls?: string[];
  /** Where each of `calls` is, as `line:column` in the file the part was found in. */
  callSites?: string[];
}

/**
 * Where an API key comes from. `literal`: written in the code; `placeholder`: a literal
 * that is not a real key (`"ollama"`, `"sk-test"`, `"EMPTY"`), as local model servers take.
 */
export type Credential =
  | "literal"
  | "placeholder"
  | "environment"
  | "parameter"
  | "default"
  | "other";

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

/** Calls that build a collection from their arguments: `new Set([...])`, `frozenset({...})`. */
const COLLECTIONS = /^(?:Set|Map|Object\.freeze|Array\.of|frozenset|set|tuple|list|dict)$/;

/**
 * Whether a value is fixed in the code: literals, and lists, dicts, sets and frozen
 * collections of them (`CHECKS.keys()` included), following names to their values.
 * A lookup into a fixed collection is fixed whatever the key.
 */
export function isFixed(value: Value, facts: FileFacts, depth = 0): boolean {
  if (depth > DEREF_DEPTH) return false;
  // A collection the code fills or changes later is not fixed, nor is an empty one.
  if (value.kind === "name" && value.assignment !== undefined && mutated(facts, value.assignment))
    return false;
  const target = deref(value, facts);
  const fixed = (item: Value) => isFixed(item, facts, depth + 1);
  switch (target.kind) {
    case "string":
      return target.template === undefined && target.truncated !== true;
    case "literal":
      return true;
    case "list":
      return target.truncated !== true && target.items.length > 0 && target.items.every(fixed);
    case "object":
      return (
        target.truncated !== true &&
        target.entries.length > 0 &&
        target.entries.every((entry) => entry.key !== null && fixed(entry.value))
      );
    case "other":
      return target.subscript === true && target.parts?.[0] !== undefined && fixed(target.parts[0]);
    case "call": {
      const call = facts.calls[target.call];
      if (call === undefined) return false;
      if (COLLECTIONS.test(call.ref?.name ?? ""))
        return (
          call.arguments.length > 0 &&
          call.arguments.every((arg) => arg.spread !== true && fixed(arg.value))
        );
      return (
        call.arguments.length === 0 && fixedReceiver(call, facts, /\.(?:keys|values|items)$/, depth)
      );
    }
    default:
      return false;
  }
}

/**
 * The values a lookup into a literal collection can give (`HANDLERS[name]`,
 * `TOOLS.run`, `TOOLS.get(name)`, `new Map([...]).get(name)`, also through a variable
 * holding the lookup): the entry a fixed key names, or every entry. Empty when the
 * collection is not a literal or the code changes it in place.
 */
export function lookupValues(lookup: Value, facts: FileFacts): Value[] {
  const value = deref(lookup, facts);
  let holder: number | undefined;
  let key: string | null = null;
  if (value.kind === "other" && value.subscript === true) {
    const [collection, index] = value.parts ?? [];
    if (collection?.kind !== "name" || collection.assignment === undefined) return [];
    holder = collection.assignment;
    key = literalString(index, facts);
  } else if (value.kind === "name" && value.base !== undefined) {
    const target = facts.assignments[value.base]?.target ?? "";
    const rest = value.text.startsWith(target) ? value.text.slice(target.length) : "";
    const member =
      /^\.([\w$]+)$/.exec(rest)?.[1] ?? /^\[\s*(["'`])([^"'`]*)\1\s*\]$/.exec(rest)?.[2];
    if (member === undefined && !/^\[[^\]]+\]$/.test(rest)) return [];
    holder = value.base;
    key = member ?? null;
  } else if (value.kind === "call") {
    const call = facts.calls[value.call];
    if (call?.receiver === undefined || !/^[\w$]+\.get$/.test(call.callee)) return [];
    holder = call.receiver;
    key = literalString(call.arguments.find((arg) => arg.keyword === null)?.value, facts);
  }
  if (holder === undefined || mutated(facts, holder)) return [];
  const assigned = facts.assignments[holder];
  if (assigned === undefined || assigned.member !== undefined) return [];
  let collection = deref(assigned.value, facts);
  if (collection.kind === "call") {
    // `new Map([["run", run]])` holds the pairs of its first argument.
    const call = facts.calls[collection.call];
    const pairs = call?.ref?.name === "Map" ? call.arguments[0]?.value : undefined;
    const list = pairs === undefined ? undefined : deref(pairs, facts);
    if (list?.kind !== "list" || list.truncated === true) return [];
    collection = {
      kind: "object",
      entries: list.items.map((item) => {
        const pair = deref(item, facts);
        const [name, entry] = pair.kind === "list" ? pair.items : [];
        return {
          key: literalString(name, facts),
          value: entry ?? { kind: "other", text: "" },
        };
      }),
    };
  }
  if (collection.kind === "object" && collection.truncated !== true)
    return collection.entries
      .filter((entry) => entry.key !== null && (key === null || entry.key === key))
      .map((entry) => entry.value);
  if (collection.kind === "list" && collection.truncated !== true && key === null)
    return collection.items;
  return [];
}

/** Methods that change a collection in place. */
const MUTATORS =
  /\.(?:add|append|extend|insert|update|setdefault|pop|popitem|remove|discard|clear|set|delete|push|unshift|splice)$/;
const mutatedIndex = new WeakMap<FileFacts, Set<number>>();

/** Whether the code changes what an assignment holds in place, by assigning into it or calling a mutator. */
function mutated(facts: FileFacts, assignment: number): boolean {
  let index = mutatedIndex.get(facts);
  if (index === undefined) {
    index = new Set(
      facts.assignments.flatMap((fact, position) => (fact.mutated === true ? [position] : [])),
    );
    for (const call of facts.calls)
      if (call.receiver !== undefined && MUTATORS.test(call.callee)) index.add(call.receiver);
    mutatedIndex.set(facts, index);
  }
  return index.has(assignment);
}

/** Whether `call` is a method matching `method` on a variable holding a fixed collection. */
function fixedReceiver(call: CallFact, facts: FileFacts, method: RegExp, depth = 0): boolean {
  if (call.receiver === undefined || !method.test(call.callee)) return false;
  const assigned = facts.assignments[call.receiver];
  return (
    assigned !== undefined &&
    assigned.member === undefined &&
    /^[\w$]+\.[\w$]+$/.test(call.callee) &&
    !mutated(facts, call.receiver) &&
    isFixed(assigned.value, facts, depth + 1)
  );
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
function originOf(value: Value, facts: FileFacts): number | null {
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

/** What tracing knows beyond one file, for `provenanceOf`. */
export interface Flow {
  /**
   * What a call's result is computed from, when the code it calls is known: the indices
   * of the arguments that reach it and the request globals it reads. Null: every argument.
   */
  call(call: CallFact): {
    args: ReadonlySet<number>;
    requests: readonly string[];
    /** False when the result does not come from the calls it is chained on either (a database row). */
    chain?: boolean;
  } | null;
  /** Values that carry nothing of where they come from, such as a file name with no separators. */
  fixed?(value: Value): boolean;
}

/** Where a value comes from, traced within one file. */
interface Provenance {
  /** Parameters of the function the value is evaluated in (never `self` or `cls`). */
  params: Set<string>;
  /** Calls (indices into `FileFacts.calls`) whose results the value is computed from. */
  calls: Set<number>;
  /** Request objects of web frameworks that are module globals (`flask.request`). */
  requests: Set<string>;
}

const PROVENANCE_DEPTH = 16;
const REQUEST_GLOBAL = /^((?:flask|quart|bottle)\.request)(?:\.|\(|$)/;
const RECEIVER = /^(?:self|cls)$/;
const IDENTIFIER = /(?<![\w$.])[A-Za-z_$][\w$]*/g;

/** The web framework request global a name reads (`flask.request` for `flask.request.args`), or null. */
export function requestObjectOf(name: string): string | null {
  return REQUEST_GLOBAL.exec(name)?.[1] ?? null;
}

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
function paramsOf(facts: FileFacts, scope: string | null): Set<string> {
  const params = definitionOf(facts, scope)?.params ?? [];
  return new Set(params.filter((param) => !RECEIVER.test(param)));
}

/**
 * Traces a value back through variables (loop variables included), calls (their
 * receivers and arguments) and string building to the parameters, calls and request
 * objects it is computed from. Over-approximates: a call's result is taken to depend
 * on everything passed to it, unless `flow` knows which arguments reach it. Names in
 * `limited` (variables or parameters of `scope` that a guard has checked) count as fixed
 * and are not followed.
 */
export function provenanceOf(
  value: Value,
  facts: FileFacts,
  scope: string | null,
  limited?: ReadonlySet<string>,
  flow?: Flow,
): Provenance {
  const params = paramsOf(facts, scope);
  const result: Provenance = { params: new Set(), calls: new Set(), requests: new Set() };
  const seen = new Set<string>();
  const request = (name: string | undefined) => {
    const object = name === undefined ? null : requestObjectOf(name);
    if (object !== null) result.requests.add(object);
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
    if (current.kind !== "literal" && current.kind !== "other" && flow?.fixed?.(current) === true)
      return;
    const local = here === scope;
    switch (current.kind) {
      case "name": {
        request(current.ref?.name);
        const root = /^[\w$]+/.exec(current.text)?.[0] ?? "";
        if (local && limited?.has(current.text)) return;
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
        // `CHECKS.get(name, default)`: one of the fixed values, or the default.
        if (fixedReceiver(call, facts, /\.get$/)) {
          for (const arg of call.arguments.slice(1)) visit(arg.value, call.scope, depth + 1);
          return;
        }
        if (call.object !== undefined) visit(call.object, call.scope, depth + 1);
        const root = /^[\w$]+/.exec(call.callee)?.[0] ?? "";
        // `name.strip()` of a checked name is as limited as the name.
        const checked = call.scope === scope && limited?.has(root) === true;
        if (call.scope === scope && params.has(root) && !checked) result.params.add(root);
        const reached = flow?.call(call) ?? null;
        for (const name of reached?.requests ?? []) result.requests.add(name);
        if (reached?.chain === false) return;
        if (call.receiver !== undefined && !checked) assignment(call.receiver, depth);
        for (const [index, arg] of call.arguments.entries())
          if (reached === null || reached.args.has(index)) visit(arg.value, call.scope, depth + 1);
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
        // A lookup into a fixed collection is one of its values, whatever the key.
        if (isFixed(current, facts)) return;
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

const callsByStart = new WeakMap<FileFacts, Map<string, number[]>>();

/**
 * Indices of the calls that start at a position, in file order. The calls of a chain
 * (`a().b().c()`) share their start, so this is how chains are followed.
 */
export function callsStartingAt(facts: FileFacts, at: { line: number; column: number }): number[] {
  let byStart = callsByStart.get(facts);
  if (byStart === undefined) {
    const index = new Map<string, number[]>();
    facts.calls.forEach((call, position) => {
      const key = `${call.span.line}:${call.span.column}`;
      const list = index.get(key) ?? [];
      list.push(position);
      index.set(key, list);
    });
    callsByStart.set(facts, index);
    byStart = index;
  }
  return byStart.get(`${at.line}:${at.column}`) ?? [];
}

/** Calls that start where a call starts and end before it: the earlier links of its chain. */
export function chainOf(facts: FileFacts, index: number): number[] {
  const call = facts.calls[index];
  if (call === undefined) return [];
  const end = call.span.endLine * 1e6 + call.span.endColumn;
  return callsStartingAt(facts, call.span).filter((other) => {
    const span = facts.calls[other]?.span;
    return span !== undefined && span.endLine * 1e6 + span.endColumn < end;
  });
}

interface TextSummary {
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
 * `scope` is the function the value is evaluated in, for tracing dynamic parts;
 * `limited` names checked values there (see `provenanceOf`).
 */
export function summarizeText(
  value: Value,
  facts: FileFacts,
  scope: string | null = null,
  limited?: ReadonlySet<string>,
  flow?: Flow,
): TextSummary | null {
  const origin = originOf(value, facts);
  const summary: TextSummary = { text: "", dynamic: [], truncated: false, fixed: [], origin };
  return appendText(summary, value, facts, scope, 0, limited, flow) ? summary : null;
}

function appendText(
  summary: TextSummary,
  value: Value,
  facts: FileFacts,
  scope: string | null,
  depth: number,
  limited: ReadonlySet<string> | undefined,
  flow: Flow | undefined,
): boolean {
  const target = depth < DEREF_DEPTH ? deref(value, facts) : value;
  // A constant from another variable is evaluated where that variable was assigned.
  const here =
    target === value || value.kind !== "name" || value.assignment === undefined
      ? scope
      : (facts.assignments[value.assignment]?.scope ?? scope);
  // Text that `flow` knows carries nothing (a path whose values stay in their components).
  const fixed =
    (target.kind === "string" || target.kind === "concat") && flow?.fixed?.(target) === true;
  switch (target.kind) {
    case "string": {
      summary.text += target.value;
      summary.fixed.push(target.value);
      if (target.truncated) summary.truncated = true;
      if (!fixed)
        for (const part of target.template ?? [])
          summary.dynamic.push(dynamicPart(part, facts, here, limited, flow));
      return true;
    }
    case "concat":
      if (fixed) {
        for (const part of target.parts) {
          const text = literalString(part, facts);
          summary.text += text ?? `{${dynamicPart(part, facts, here, limited, flow).text}}`;
          if (text !== null) summary.fixed.push(text);
        }
        return true;
      }
      for (const part of target.parts) {
        if (!appendText(summary, part, facts, here, depth + 1, limited, flow)) {
          const dynamic = dynamicPart(part, facts, here, limited, flow);
          summary.text += `{${dynamic.text}}`;
          summary.dynamic.push(dynamic);
        }
      }
      return true;
    case "name":
    case "call": {
      if (depth > 0) return false;
      const dynamic = dynamicPart(value, facts, scope, limited, flow);
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
  limited?: ReadonlySet<string>,
  flow?: Flow,
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
  const provenance = provenanceOf(value, facts, scope, limited, flow);
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
/** Argument paths under which SDKs and frameworks take an API key. */
const API_KEY_PATHS =
  "api_key|apiKey|openai_api_key|openAIApiKey|anthropic_api_key|anthropicApiKey|google_api_key";

/** API keys written in the code, whatever their format, so that no part of a report repeats them. */
export function literalCredentials(files: readonly { facts: FileFacts }[]): string[] {
  const keys = new Set<string>();
  for (const { facts } of files) {
    for (const call of facts.calls) {
      for (const value of select(call.arguments, facts, API_KEY_PATHS)) {
        const text = literalString(value, facts);
        if (text !== null && looksLikeSecret(text)) keys.add(text);
      }
    }
  }
  return [...keys];
}

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
