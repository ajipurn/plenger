/**
 * What a value can be inside a file path or among a program's arguments, read from how
 * the code builds it: one file name that cannot leave the directory it is joined to, or
 * an absolute path that cannot be read as an option. Both follow project functions,
 * reading their returns with what the call passes.
 */

import type { CallFact, DefinitionFact, FileFacts, Value } from "../facts/model.ts";
import { callsStartingAt, definitionOf, deref, literalString, select } from "../facts/query.ts";
import type { ProjectIndex } from "../project/index.ts";
import type { Project, ProjectFile } from "../project/project.ts";

/**
 * How a value works as one path component, from worst to best. `plain`: it holds no path
 * separator but may be `.` or `..`. `safe`: neither, though it may be empty. `marked`:
 * it also always holds a character that is not a dot or a space. `named`: that character
 * is a letter or digit, which sanitizers that remove characters keep.
 */
export type NameLevel = "unknown" | "plain" | "safe" | "marked" | "named";
const ORDER: NameLevel[] = ["unknown", "plain", "safe", "marked", "named"];

/** Whether a component at this level stays in the directory it is joined to. */
export function staysInDirectory(level: NameLevel): boolean {
  return ORDER.indexOf(level) >= ORDER.indexOf("safe");
}

/** How deep values and project functions are followed. */
const DEPTH = 8;

/** Sanitizers whose result is one file name that is never `.` or `..`. */
const STRICT =
  /^(?:werkzeug\.utils\.secure_filename|werkzeug\.secure_filename|django\.utils\.text\.get_valid_filename|sanitize-filename(?:#default)?)$/;
/** The last component of a path: `basename`, which is `..` for `a/..`. */
const BASENAME = /(?:^|[.#])basename$/;
/** Members that are one component of a parsed path: `path.parse(p).name`, `PurePath(p).stem`. */
const PARSED_PART =
  /^(?:(?:node:)?path(?:#default\.|#)parse\(\)\.(?:name|base)|pathlib\.(?:Pure|Posix|Windows)?Path\(\)\.(?:name|stem))$/;
/** The host of a WHATWG URL, which reads `\` as `/` for web schemes: never a separator. */
const URL_HOST = /^(?:(?:node:)?url#)?URL\(\)\.hostname$/;
/** Methods that change case or trim whitespace, keeping what makes a name a name. */
const CASE_OR_TRIM = /\.(?:toLowerCase|toUpperCase|trim|lower|upper|casefold|strip)$/;
/** Calls that only change a value's type: `str(x)`, `String(x)`. */
const TO_TEXT = /^(?:str|String)$/;
/** Generated ids, which hold only letters, digits, `-` and `_`: UUIDs and nanoid's default ids. */
const GENERATED_ID =
  /^(?:uuid(?:#default\.|#)v[1-7]|(?:node:)?crypto(?:#default\.|#)randomUUID|crypto\.randomUUID|nanoid#nanoid|uuid\.uuid[1345])$/;
/** Calls whose result is always an absolute path. */
const ABSOLUTE =
  /^(?:(?:node:)?path(?:#default\.|#)resolve|os\.path\.(?:abspath|realpath)|(?:node:)?fs(?:#default\.|#)realpathSync)$/;
/** Calls that keep an absolute path absolute: normalizing, trimming, pathlib's `resolve()`. */
const KEEPS_ABSOLUTE = /(?:^|[.#])(?:normalize|normpath|resolve|trim|strip|toString)$/;

/** What a sanitizer that replaces characters by a regular expression does to a name. */
type Replacement = "none" | "separators" | "separators-keeping-letters";

export class PathValues {
  readonly #project: Project;
  readonly #index: ProjectIndex;
  /** Levels of values read without parameter levels, which is how tracing asks. */
  readonly #levels = new WeakMap<Value, NameLevel>();
  readonly #absolute = new WeakMap<Value, boolean>();

  constructor(project: Project, index: ProjectIndex) {
    this.#project = project;
    this.#index = index;
  }

  /**
   * The level of a value as one path component. `params` gives the levels of the
   * parameters of the function the value is in, when it is read for a call.
   */
  nameLevel(
    file: ProjectFile,
    value: Value,
    params: ReadonlyMap<string, NameLevel> = new Map(),
    depth = 0,
  ): NameLevel {
    if (depth > DEPTH) return "unknown";
    if (params.size === 0) {
      const known = this.#levels.get(value);
      if (known !== undefined) return known;
      // A value that reaches itself again reads as unknown.
      this.#levels.set(value, "unknown");
      const level = this.#level(file, value, params, depth);
      this.#levels.set(value, level);
      return level;
    }
    return this.#level(file, value, params, depth);
  }

  #level(
    file: ProjectFile,
    value: Value,
    params: ReadonlyMap<string, NameLevel>,
    depth: number,
  ): NameLevel {
    const next = (item: Value) => this.nameLevel(file, item, params, depth + 1);
    switch (value.kind) {
      case "string": {
        if (value.template === undefined || value.template.length === 0)
          return fixedLevel(value.value);
        const fixed = fixedLevel(withoutPlaceholders(value.value, file.language === "python"));
        return combine([fixed, ...value.template.map(next)]);
      }
      case "concat":
        return combine(value.parts.map(next));
      case "name": {
        if (value.param) return params.get(value.text) ?? "unknown";
        const ref = value.ref?.name ?? "";
        if (PARSED_PART.test(ref)) return "plain";
        if (file.language !== "python" && URL_HOST.test(ref)) return "plain";
        // `data.id` of `data = { id: v4() }`, an object the code never changes in place.
        const key = /^[\w$]+\.([\w$]+)$/.exec(value.text)?.[1];
        const holder = value.base === undefined ? undefined : file.facts.assignments[value.base];
        const object =
          key === undefined || holder === undefined || holder.member !== undefined || holder.mutated
            ? undefined
            : deref(holder.value, file.facts);
        if (object?.kind === "object") {
          const entry = object.entries.find((item) => item.key === key);
          return entry === undefined ? "unknown" : next(entry.value);
        }
        const target = deref(value, file.facts);
        return target === value ? "unknown" : next(target);
      }
      case "call": {
        const call = file.facts.calls[value.call];
        return call === undefined ? "unknown" : this.#callLevel(file, call, params, depth);
      }
      default:
        return "unknown";
    }
  }

  #callLevel(
    file: ProjectFile,
    call: CallFact,
    params: ReadonlyMap<string, NameLevel>,
    depth: number,
  ): NameLevel {
    const facts = file.facts;
    const name = call.ref?.name ?? call.callee;
    const python = file.language === "python";
    const level = (item: Value | undefined) =>
      item === undefined ? "unknown" : this.nameLevel(file, item, params, depth + 1);
    const [first, second] = call.arguments.map((arg) => arg.value);
    const lettered = (item: Value | undefined) =>
      item !== undefined && this.#lettered(file, item, params, depth + 1);
    if (STRICT.test(name)) {
      if (call.arguments.length !== 1) return "unknown";
      return lettered(first) ? "named" : "safe";
    }
    // python-slugify keeps lowercase letters, digits and hyphens.
    if (python && name === "slugify.slugify") {
      if (call.arguments.some((arg) => arg.keyword === "regex_pattern")) return "unknown";
      return lettered(first) ? "named" : "safe";
    }
    // The `slugify` package removes every character outside `\w`, spaces and `$*_+~.()'"!-:@`,
    // then puts its replacement (`-`, or the second argument) between words.
    if (!python && /^slugify(?:#default)?$/.test(name)) {
      const options = second === undefined ? [] : [{ keyword: null, value: second }];
      const remove = select(options, facts, "#0.remove");
      const replacement =
        second === undefined
          ? "-"
          : (literalString(second, facts) ??
            (select(options, facts, "#0.replacement").length === 0
              ? "-"
              : literalString(select(options, facts, "#0.replacement")[0], facts)));
      return remove.length > 0 || replacement === null || /[/\\]/.test(replacement)
        ? "unknown"
        : keepsLetters(lettered(first), "separators-keeping-letters");
    }
    // The last component of a path that ends with `.json` ends with `.json`: never `..`.
    if (BASENAME.test(name) && call.arguments.length === 1)
      return first !== undefined && endsWithLetters(facts, call, first) ? "named" : "plain";
    if (TO_TEXT.test(name) && call.arguments.length === 1) return level(first);
    if (GENERATED_ID.test(name)) return "named";
    if (python && name === "re.sub") {
      // `re.sub(pattern, repl, string, count=0, flags=0)`: a count replaces only that many.
      const positional = call.arguments.filter((arg) => arg.keyword === null);
      const [pattern, replacement, input, count] = ["pattern", "repl", "string", "count"].map(
        (keyword, index) =>
          (call.arguments.find((arg) => arg.keyword === keyword) ?? positional[index])?.value,
      );
      if (call.arguments.some((arg) => arg.spread)) return "unknown";
      const counted = count === undefined ? undefined : deref(count, facts);
      if (counted !== undefined && !(counted.kind === "literal" && counted.text === "0"))
        return "unknown";
      return keepsLetters(
        lettered(input),
        replaces(literalString(pattern, facts), replacement, facts),
      );
    }
    if (!python && /\.(?:replace|replaceAll)$/.test(call.callee)) {
      const literal = first === undefined ? undefined : deref(first, facts);
      const match = literal?.kind === "literal" ? /^\/(.*)\/([a-z]*)$/s.exec(literal.text) : null;
      const global = match?.[2]?.includes("g") === true;
      const effect = global ? replaces(match?.[1] ?? null, second, facts) : "none";
      return keepsLetters(lettered(receiverOf(facts, call)), effect);
    }
    const replaced = python ? textReplacements(facts, call) : null;
    if (replaced !== null) {
      const effect = replaced.letters ? "separators-keeping-letters" : "separators";
      if (replaced.separators) return keepsLetters(lettered(replaced.input), effect);
      // Replacements that add no separator keep a name free of them, though it may become `..`.
      const before = level(replaced.input);
      if (before === "unknown") return "unknown";
      return before === "named" && replaced.letters ? "named" : "plain";
    }
    if (CASE_OR_TRIM.test(call.callee) && call.arguments.length === 0)
      return level(receiverOf(facts, call));
    const callee = this.#callee(file, call);
    if (callee === null) return "unknown";
    const bound = bindArguments(call, callee.definition, callee.python, (item) => level(item));
    return lowest(
      callee.returns.map((item) => this.nameLevel(callee.file, item, bound, depth + 1)),
    );
  }

  /**
   * Whether a path built from fixed text and values (`` `/srv/${slug}.txt` ``,
   * `"reports/" + name`) keeps every value inside one component that stays in its
   * directory, so the values cannot move the path out of its fixed part.
   */
  componentsStay(file: ProjectFile, value: Value): boolean {
    const pieces = pathPieces(value, file.language === "python");
    if (
      pieces === null ||
      !pieces.some((piece) => typeof piece === "string" && /[/\\]/.test(piece))
    )
      return false;
    const components: (string | Value)[][] = [[]];
    for (const piece of pieces) {
      if (typeof piece !== "string") {
        components.at(-1)?.push(piece);
        continue;
      }
      const [head, ...rest] = piece.split(/[/\\]/);
      components.at(-1)?.push(head ?? "");
      for (const part of rest) components.push([part]);
    }
    return components.every((component) => {
      if (component.every((piece) => typeof piece === "string")) return true;
      const levels = component.map((piece) =>
        typeof piece === "string" ? fixedLevel(piece) : this.nameLevel(file, piece),
      );
      return staysInDirectory(combine(levels));
    });
  }

  /**
   * Whether a value always holds a fixed letter or digit, whatever else it holds:
   * `${author} transcripts`, or a name a sanitizer made from one. A sanitizer that
   * removes separators keeps it, so the result is never `.` or `..`.
   */
  #lettered(
    file: ProjectFile,
    value: Value,
    params: ReadonlyMap<string, NameLevel>,
    depth: number,
  ): boolean {
    if (depth > DEPTH) return false;
    const next = (item: Value | undefined) =>
      item !== undefined && this.#lettered(file, item, params, depth + 1);
    switch (value.kind) {
      case "string":
        return (
          /[A-Za-z0-9]/.test(
            value.template === undefined
              ? value.value
              : withoutPlaceholders(value.value, file.language === "python"),
          ) || (value.template ?? []).some(next)
        );
      case "concat":
        return value.parts.some(next);
      case "name": {
        if (value.param) return params.get(value.text) === "named";
        const target = deref(value, file.facts);
        return target !== value && next(target);
      }
      case "call": {
        const call = file.facts.calls[value.call];
        if (call === undefined) return false;
        const name = call.ref?.name ?? call.callee;
        if (CASE_OR_TRIM.test(call.callee) && call.arguments.length === 0)
          return next(receiverOf(file.facts, call));
        if (TO_TEXT.test(name) || STRICT.test(name) || /slugify/.test(name))
          return next(call.arguments[0]?.value);
        return this.nameLevel(file, value, params, depth) === "named";
      }
      default:
        return false;
    }
  }

  /** Whether a value is always an absolute path, which cannot be read as an option. */
  absolute(
    file: ProjectFile,
    value: Value,
    params: ReadonlyMap<string, boolean> = new Map(),
    depth = 0,
  ): boolean {
    if (depth > DEPTH) return false;
    if (params.size === 0) {
      const known = this.#absolute.get(value);
      if (known !== undefined) return known;
      this.#absolute.set(value, false);
      const result = this.#isAbsolute(file, value, params, depth);
      this.#absolute.set(value, result);
      return result;
    }
    return this.#isAbsolute(file, value, params, depth);
  }

  #isAbsolute(
    file: ProjectFile,
    value: Value,
    params: ReadonlyMap<string, boolean>,
    depth: number,
  ): boolean {
    const facts = file.facts;
    const next = (item: Value | undefined) =>
      item !== undefined && this.absolute(file, item, params, depth + 1);
    if (value.kind === "name") {
      if (value.param) return params.get(value.text) === true;
      const target = deref(value, facts);
      return target !== value && next(target);
    }
    const call = value.kind === "call" ? facts.calls[value.call] : undefined;
    if (call === undefined) return false;
    const name = call.ref?.name ?? call.callee;
    if (ABSOLUTE.test(name)) return true;
    if (KEEPS_ABSOLUTE.test(name) && call.arguments.length <= 1)
      return next(call.arguments[0]?.value ?? receiverOf(facts, call));
    // `name.replace(/^(\.\.(\/|\\|$))+/, "")` cannot touch a path that starts with `/`.
    if (/\.replace$/.test(call.callee)) {
      const first = call.arguments[0];
      const pattern = first === undefined ? undefined : deref(first.value, facts);
      const anchored = pattern?.kind === "literal" && /^\/\^\(*\\\./.test(pattern.text);
      return anchored && next(receiverOf(facts, call));
    }
    const callee = this.#callee(file, call);
    if (callee === null) return false;
    const bound = bindArguments(call, callee.definition, callee.python, (item) => next(item));
    return callee.returns.every((item) => this.absolute(callee.file, item, bound, depth + 1));
  }

  /** The project function a call runs and the values it returns, or null when unknown. */
  #callee(
    file: ProjectFile,
    call: CallFact,
  ): { file: ProjectFile; definition: DefinitionFact; python: boolean; returns: Value[] } | null {
    const target = this.#index.calledFunction(file, call);
    const callee = target === null ? undefined : this.#project.files.get(target.path);
    const definition =
      target === null || callee === undefined
        ? undefined
        : definitionOf(callee.facts, target.definition);
    const returns = definition?.returns ?? [];
    if (callee === undefined || definition === undefined) return null;
    if (definition.kind === "class" || returns.length === 0 || returns.length >= 10) return null;
    return { file: callee, definition, python: callee.language === "python", returns };
  }
}

/** What `call` passes for each parameter of `definition`, read by `read`; nothing for names a pattern unpacks. */
function bindArguments<T>(
  call: CallFact,
  definition: DefinitionFact,
  python: boolean,
  read: (value: Value) => T,
): Map<string, T> {
  const bound = new Map<string, T>();
  if (definition.unpacks !== undefined) {
    for (const [index, arg] of call.arguments.entries()) {
      if (arg.spread) break;
      const param = definition.unpacks[index];
      if (typeof param === "string") bound.set(param, read(arg.value));
    }
    return bound;
  }
  const params =
    python && definition.kind === "method" && /^(?:self|cls)$/.test(definition.params[0] ?? "")
      ? definition.params.slice(1)
      : definition.params;
  let position = 0;
  for (const arg of call.arguments) {
    if (arg.spread) break;
    const name = arg.keyword ?? params[position++];
    if (name !== undefined) bound.set(name, read(arg.value));
  }
  return bound;
}

/**
 * What a call is made on: the parenthesized expression, the variable, the call before
 * it in a chain (`slugify(x).toLowerCase()`), or the parameter its callee starts with.
 */
function receiverOf(facts: FileFacts, call: CallFact): Value | undefined {
  if (call.object !== undefined) return call.object;
  if (call.receiver !== undefined) {
    const holder = facts.assignments[call.receiver];
    if (holder !== undefined && holder.member === undefined)
      return { kind: "name", text: holder.target, ref: null, assignment: call.receiver };
  }
  const end = (span: CallFact["span"]) => span.endLine * 1e6 + span.endColumn;
  let previous: number | undefined;
  for (const index of callsStartingAt(facts, call.span)) {
    const span = facts.calls[index]?.span;
    if (span === undefined || end(span) >= end(call.span)) continue;
    const best = previous === undefined ? undefined : facts.calls[previous]?.span;
    if (best === undefined || end(span) > end(best)) previous = index;
  }
  if (previous !== undefined) return { kind: "call", call: previous };
  const root = /^[A-Za-z_$][\w$]*/.exec(call.callee)?.[0];
  const scope = definitionOf(facts, call.scope);
  return root !== undefined && scope?.params.includes(root) && call.callee.startsWith(`${root}.`)
    ? { kind: "name", text: root, ref: null, param: true }
    : undefined;
}

/**
 * The fixed text and values a string is built from, in order: a template's text split
 * around its interpolations, or a concatenation's parts. Null for anything else.
 */
function pathPieces(value: Value, python: boolean): (string | Value)[] | null {
  if (value.kind === "concat") {
    const pieces: (string | Value)[] = [];
    for (const part of value.parts) {
      if (part.kind === "string" && part.template === undefined) pieces.push(part.value);
      else if (part.kind === "string") {
        const inner = pathPieces(part, python);
        if (inner === null) return null;
        pieces.push(...inner);
      } else pieces.push(part);
    }
    return pieces;
  }
  if (value.kind !== "string" || value.template === undefined) return null;
  const placeholder = python ? /\{[^{}]*\}/g : /\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
  const texts = value.value.split(placeholder);
  if (texts.length !== value.template.length + 1) return null;
  const pieces: (string | Value)[] = [];
  texts.forEach((text, index) => {
    pieces.push(text);
    const item = value.template?.[index];
    if (item !== undefined) pieces.push(item);
  });
  return pieces;
}

/**
 * Whether a guard in force at `call` checks that `value` ends with fixed text that
 * holds a letter or digit and no separator (`if not name.endswith(".json"): return`).
 */
function endsWithLetters(facts: FileFacts, call: CallFact, value: Value): boolean {
  if (value.kind !== "name") return false;
  const at = call.span.line * 1e6 + call.span.column;
  return (facts.guards ?? []).some((guard) => {
    if (guard.test !== "ends" || guard.scope !== call.scope) return false;
    if (guard.subject.kind !== "name" || guard.subject.text !== value.text) return false;
    const { region } = guard;
    if (at < region.line * 1e6 + region.column || at > region.endLine * 1e6 + region.endColumn)
      return false;
    const suffix = literalString(guard.allowed, facts);
    return suffix !== null && /[A-Za-z0-9]/.test(suffix) && !/[/\\]/.test(suffix);
  });
}

/** The level of fixed text inside a component. */
function fixedLevel(text: string): NameLevel {
  if (/[/\\]/.test(text)) return "unknown";
  if (/[A-Za-z0-9]/.test(text)) return "named";
  if (/[^.\s]/.test(text)) return "marked";
  return text === "" ? "safe" : "plain";
}

/** Fixed text of a string with its interpolations taken out (`${x}` in JS, `{x}` in f-strings). */
function withoutPlaceholders(text: string, python: boolean): string {
  return python
    ? text.replace(/\{\{|\}\}/g, "").replace(/\{[^{}]*\}/g, "")
    : text.replace(/\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, "");
}

/**
 * The level of a component built by joining pieces: unknown if any piece is, the
 * strongest guarantee any piece gives otherwise, `safe` when every piece is at least
 * safe (pieces that are neither `.` nor `..` cannot join into one), `plain` else.
 */
function combine(levels: NameLevel[]): NameLevel {
  if (levels.includes("unknown")) return "unknown";
  if (levels.includes("named")) return "named";
  if (levels.includes("marked")) return "marked";
  return levels.every((level) => staysInDirectory(level)) ? "safe" : "plain";
}

function lowest(levels: NameLevel[]): NameLevel {
  return levels.reduce<NameLevel>(
    (low, level) => (ORDER.indexOf(level) < ORDER.indexOf(low) ? level : low),
    "named",
  );
}

/** A name with separators replaced: `named` when the input held a fixed letter and letters survive, `plain` else. */
function keepsLetters(lettered: boolean, effect: Replacement): NameLevel {
  if (effect === "none") return "unknown";
  return lettered && effect === "separators-keeping-letters" ? "named" : "plain";
}

/**
 * A chain of Python `str.replace` calls with fixed text, which replace every occurrence
 * (`name.replace("/", "-").replace("\\", "-")`): the value it starts from, whether it
 * removes both path separators, and whether it leaves letters and digits alone. Null
 * when a call of the chain is not such a replacement or puts a separator in.
 */
function textReplacements(
  facts: FileFacts,
  call: CallFact,
): { input: Value | undefined; separators: boolean; letters: boolean } | null {
  const removed = new Set<string>();
  let letters = true;
  let current: CallFact | undefined = call;
  let input: Value | undefined;
  for (let depth = 0; current !== undefined; depth++) {
    const args = current.arguments;
    const [old, replacement] = args.map((arg) => literalString(arg.value, facts));
    if (
      depth > DEPTH ||
      !/\.replace$/.test(current.callee) ||
      args.length !== 2 ||
      args.some((arg) => arg.keyword !== null || arg.spread) ||
      old == null ||
      replacement == null ||
      /[/\\]/.test(replacement)
    )
      return null;
    // String values keep their escapes: the text of `"\\"` is two backslashes.
    if (old === "/") removed.add("/");
    if (old === "\\\\") removed.add("\\");
    if (/[A-Za-z0-9]/.test(old)) letters = false;
    input = receiverOf(facts, current);
    const inner = input?.kind === "call" ? facts.calls[input.call] : undefined;
    current = inner !== undefined && /\.replace$/.test(inner.callee) ? inner : undefined;
  }
  return { input, separators: removed.size === 2, letters };
}

/**
 * What replacing every match of a one-character-class pattern with `replacement` does:
 * `separators` when no path separator can be left, because the class matches `/` and `\`
 * (`[\/\\:*?]`) or is negated and admits neither (`[^\w.-]`), and the replacement holds
 * none. Letters survive when a class of removed characters has no letters or digits, or
 * a negated class admits them all.
 */
function replaces(
  pattern: string | null,
  replacement: Value | undefined,
  facts: FileFacts,
): Replacement {
  const text = replacement === undefined ? null : literalString(replacement, facts);
  if (pattern === null || text === null || /[/\\]/.test(text)) return "none";
  const match = /^\[(\^?)((?:\\.|[^\]\\])*)\](?:[+*]|\{\d+(?:,\d*)?\})?$/s.exec(pattern);
  if (match === null) return "none";
  const member = classMembers(match[2] ?? "");
  const letters = ["a", "z", "A", "Z", "0", "9"];
  if (match[1] === "^") {
    if (member("/") || member("\\")) return "none";
    return letters.every(member) ? "separators-keeping-letters" : "separators";
  }
  if (!member("/") || !member("\\")) return "none";
  return letters.some(member) ? "separators" : "separators-keeping-letters";
}

/** A membership test for the body of a regular expression character class. */
function classMembers(body: string): (char: string) => boolean {
  const items: { char: string; escaped: boolean }[] = [];
  const classes = new Set<string>();
  for (let index = 0; index < body.length; index++) {
    const char = body[index] as string;
    if (char === "\\" && index + 1 < body.length) {
      const escaped = body[++index] as string;
      if (/[wdsWDS]/.test(escaped)) classes.add(escaped);
      else items.push({ char: escaped, escaped: true });
    } else items.push({ char, escaped: false });
  }
  const singles = new Set<string>();
  const ranges: [string, string][] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const dash = items[index + 1];
    const end = items[index + 2];
    if (item === undefined) continue;
    if (dash?.char === "-" && !dash.escaped && end !== undefined) {
      ranges.push([item.char, end.char]);
      index += 2;
    } else singles.add(item.char);
  }
  const shorthand: Record<string, RegExp> = {
    w: /\w/,
    d: /\d/,
    s: /\s/,
    W: /\W/,
    D: /\D/,
    S: /\S/,
  };
  return (char) =>
    singles.has(char) ||
    ranges.some(([from, to]) => char >= from && char <= to) ||
    [...classes].some((name) => shorthand[name]?.test(char) === true);
}
