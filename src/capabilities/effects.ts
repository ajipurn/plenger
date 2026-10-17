/**
 * Following a project function down to calls with an outside effect: sinks from the
 * catalog, SQLite statements, environment reads, and the effects of the project
 * functions it calls, with the caller's arguments bound to the callee's parameters.
 */

import type { CallFact, FileFacts, GuardFact, Span, Value } from "../facts/model.ts";
import {
  callsStartingAt,
  type DynamicPart,
  definitionOf,
  deref,
  dynamicPart,
  isFixed,
  literalString,
  lookupValues,
  provenanceOf,
  select,
  summarizeText,
} from "../facts/query.ts";
import type {
  Agent,
  Capability,
  CapabilityKind,
  Inventory,
  LlmCall,
  Location,
  TraceGaps,
} from "../inventory/model.ts";
import { MODULE_SCOPE, type ProjectIndex } from "../project/index.ts";
import type { Project, ProjectFile } from "../project/project.ts";
import { compareStrings } from "../shared/compare.ts";
import { locationKey } from "../shared/location.ts";
import { compiledSinks, sinksFor } from "./catalog.ts";
import type { Sink } from "./sinks.ts";

/** How many project functions deep the analysis follows calls. */
export const MAX_DEPTH = 6;
/** Calls a `TraceGaps` lists by location; the counts cover every one. */
const TRACE_GAP_LOCATIONS = 10;
const ENVIRONMENT = /^(?:os\.environ|process\.env|import\.meta\.env)\.[\w$]+$/;

/** What tracing one function could not follow, and the project functions it went into. */
interface Visit {
  depthLimited: Map<string, Location>;
  dynamic: Map<string, Location>;
  callees: Set<string>;
}

interface Guard {
  name: string;
  kinds: CapabilityKind[];
  /** Parameters the checked value comes from. */
  params: Set<string>;
}

/** What a caller passes for a parameter: its non-constant parts, and those that decide a URL's host. */
interface Bound {
  inputs: DynamicPart[];
  host: DynamicPart[];
}

/** Traces effects through the project, remembering the result for every function it has visited. */
export class EffectTracer {
  readonly #project: Project;
  readonly #index: ProjectIndex;
  readonly #llmCalls = new Map<string, LlmCall>();
  readonly #agentRuns = new Map<string, { agent: Agent; inputs: DynamicPart[] }>();
  readonly #memo = new Map<string, Capability[]>();
  readonly #active = new Set<string>();
  readonly #visits = new Map<string, Visit>();
  readonly #tracing: Visit[] = [];

  constructor(project: Project, index: ProjectIndex, inventory: Inventory) {
    this.#project = project;
    this.#index = index;
    for (const call of inventory.llmCalls) this.#llmCalls.set(locationKey(call.location), call);
    for (const agent of inventory.agents) {
      for (const run of agent.invocations)
        this.#agentRuns.set(locationKey(run.location), { agent, inputs: run.inputs });
    }
  }

  /** Effects of a project function (or a file's module code) and of the project functions it calls. */
  effects(path: string, definition: string, depth: number): Capability[] {
    const memoKey = `${path}|${definition}`;
    const cached = this.#memo.get(memoKey);
    if (cached !== undefined) return cached;
    const file = this.#project.files.get(path);
    if (file === undefined || this.#active.has(memoKey) || depth > MAX_DEPTH) return [];
    this.#active.add(memoKey);
    const visit: Visit = { depthLimited: new Map(), dynamic: new Map(), callees: new Set() };
    this.#visits.set(memoKey, visit);
    this.#tracing.push(visit);
    const scopes = this.#index.scopesOf(file, definition);
    const found: Capability[] = [];
    const guards: Guard[] = [];
    for (const call of file.facts.calls) {
      if (!scopes.has(call.scope ?? MODULE_SCOPE)) continue;
      found.push(...this.callEffects(file, call, depth));
      const guard = this.guardOf(file, call);
      if (guard !== null) guards.push(guard);
    }
    found.push(...this.environmentReads(file, scopes));
    this.#tracing.pop();
    this.#active.delete(memoKey);
    const result = unique(found).map((effect) => withGuards(effect, guards));
    this.#memo.set(memoKey, result);
    return result;
  }

  /**
   * Calls that tracing a function and every project function it reached could not
   * follow, or null when it followed all of them. Call `effects` for the function first.
   */
  gaps(path: string, definition: string): TraceGaps | null {
    const depthLimited = new Map<string, Location>();
    const dynamic = new Map<string, Location>();
    const seen = new Set<string>();
    const pending = [`${path}|${definition}`];
    for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
      const visit = seen.has(key) ? undefined : this.#visits.get(key);
      seen.add(key);
      if (visit === undefined) continue;
      for (const [id, location] of visit.depthLimited) depthLimited.set(id, location);
      for (const [id, location] of visit.dynamic) dynamic.set(id, location);
      pending.push(...visit.callees);
    }
    if (depthLimited.size === 0 && dynamic.size === 0) return null;
    const ordered = (calls: Map<string, Location>) =>
      [...calls.values()].sort(
        (a, b) => compareStrings(a.path, b.path) || a.line - b.line || a.column - b.column,
      );
    return {
      depthLimited: depthLimited.size,
      dynamic: dynamic.size,
      locations: [...ordered(depthLimited), ...ordered(dynamic)].slice(0, TRACE_GAP_LOCATIONS),
    };
  }

  callEffects(file: ProjectFile, call: CallFact, depth: number): Capability[] {
    const location = locate(file.path, call.span);
    const effects: Capability[] = [];
    const llm = this.#llmCalls.get(locationKey(location));
    if (llm !== undefined) {
      const effect: Capability = {
        kind: "llm",
        target: llm.target,
        location,
        via: [],
        inputs: llm.inputs,
      };
      if (llm.systemInputs.length > 0) effect.systemInputs = llm.systemInputs;
      effects.push(effect);
    }
    const run = this.#agentRuns.get(locationKey(location));
    if (run !== undefined) {
      effects.push({ kind: "agent", target: run.agent.id, location, via: [], inputs: run.inputs });
    }
    // What guards around the call check, for file effects and for the others.
    const limits = limitsAt(file.facts, call);
    const checked = new Map<boolean, ReadonlySet<string> | undefined>();
    const limitedFor = (kind: CapabilityKind) => {
      const forFile = FILE_KINDS.has(kind);
      if (!checked.has(forFile))
        checked.set(
          forFile,
          limits.length === 0
            ? undefined
            : coveredNames(file.facts, call, safeSubjects(kind, limits, file.facts)),
        );
      return checked.get(forFile);
    };
    // A call through a fixed table (`HANDLERS[name](x)`) runs one of the functions it holds.
    const target = this.#index.calledFunction(file, call);
    const entries =
      target === null && call.lookup !== undefined && call.ref?.kind !== "import"
        ? lookupValues(call.lookup, file.facts).map((value) => deref(value, file.facts))
        : [];
    const callees = [
      call,
      ...entries.flatMap((entry) =>
        entry.kind === "name" && entry.ref !== null ? [{ ...call, ref: entry.ref }] : [],
      ),
    ];
    for (const callee of callees) {
      const name = callee.ref?.name;
      if (name === undefined || callee.ref?.kind === "local") continue;
      const sqlite = this.sqliteEffect(file, callee, location, limitedFor("database"));
      if (sqlite !== null) effects.push(sqlite);
      const match = sinksFor(file.language).find(({ pattern }) => pattern.test(name));
      if (match !== undefined)
        effects.push(this.sinkEffect(file, callee, match.sink, location, limitedFor));
    }
    const targets =
      target !== null
        ? [target]
        : [
            ...entries.flatMap((entry) =>
              entry.kind === "function" ? [{ path: file.path, definition: entry.definition }] : [],
            ),
            ...callees.slice(1).flatMap((callee) => this.#index.calledFunction(file, callee) ?? []),
          ];
    const visit = this.#tracing.at(-1);
    if (
      targets.length === 0 &&
      visit !== undefined &&
      effects.length === 0 &&
      dynamicCall(file, call)
    )
      visit.dynamic.set(locationKey(location), location);
    for (const target of targets) {
      if (depth + 1 > MAX_DEPTH && !this.#memo.has(`${target.path}|${target.definition}`)) {
        visit?.depthLimited.set(locationKey(location), location);
        continue;
      }
      visit?.callees.add(`${target.path}|${target.definition}`);
      const fileBindings = this.bindArguments(file, call, target, limitedFor("file_write"));
      const otherBindings = this.bindArguments(file, call, target, limitedFor("process"));
      for (const effect of this.effects(target.path, target.definition, depth + 1)) {
        const bindings = FILE_KINDS.has(effect.kind) ? fileBindings : otherBindings;
        const bound: Capability = {
          ...effect,
          via: [location, ...effect.via],
          inputs: rebind(effect.inputs, bindings, "inputs"),
        };
        if (effect.systemInputs !== undefined)
          bound.systemInputs = rebind(effect.systemInputs, bindings, "inputs");
        if (effect.dataInputs !== undefined)
          bound.dataInputs = rebind(effect.dataInputs, bindings, "inputs");
        if (effect.host !== undefined) {
          // A URL passed in decides the host by what the caller put at its start.
          const host = rebind(effect.host, bindings, "host");
          if (host.length > 0) bound.host = host;
          else delete bound.host;
        }
        effects.push(bound);
      }
    }
    return limits.length === 0
      ? effects
      : effects.map((effect) => narrowed(effect, limits, file.facts, call));
  }

  /** Preparing SQL does not execute it; bind data separately from the SQL text. */
  sqliteEffect(
    file: ProjectFile,
    call: CallFact,
    location: Location,
    limited?: ReadonlySet<string>,
  ): Capability | null {
    const name = call.ref?.name ?? "";
    if (!/^(?:better-sqlite3(?:#default)?\(\)|node:sqlite#Database(?:Sync)?\(\))/.test(name))
      return null;
    let statement: CallFact | undefined;
    let data: Value[] = [];
    if (name.endsWith(".exec")) statement = call;
    else if (/\.prepare\(\)\.(?:run|get|all|iterate)$/.test(name)) {
      statement = chainHead(file.facts, call);
      if (statement?.ref?.name.endsWith(".prepare") !== true) {
        const assigned =
          call.receiver === undefined ? undefined : file.facts.assignments[call.receiver];
        const value = assigned === undefined ? undefined : deref(assigned.value, file.facts);
        statement = value?.kind === "call" ? file.facts.calls[value.call] : undefined;
      }
      data = call.arguments.map((argument) => argument.value);
    }
    if (statement === undefined) return null;
    const queries = select(statement.arguments, file.facts, "#0");
    const query = literalString(queries[0], file.facts);
    const operation = sqlOperation(query);
    return {
      kind: "database",
      target: name,
      location,
      via: [],
      query: true,
      operation: operation ?? "unknown",
      inputs: uniqueParts(
        queries.flatMap((value) => inputsOf(value, file.facts, call.scope, limited)),
      ),
      dataInputs: uniqueParts(
        data.flatMap((value) => inputsOf(value, file.facts, call.scope, limited)),
      ),
    };
  }

  /**
   * What the caller passes for each parameter of the called function, so an effect's
   * input that is a parameter there becomes what the caller gave (`run(f"... {service}")`).
   */
  bindArguments(
    file: ProjectFile,
    call: CallFact,
    target: { path: string; definition: string },
    limited?: ReadonlySet<string>,
  ): Map<string, Bound> {
    const callee = this.#project.files.get(target.path);
    const definition =
      callee === undefined ? undefined : definitionOf(callee.facts, target.definition);
    const bindings = new Map<string, Bound>();
    if (definition === undefined) return bindings;
    let params = definition.params;
    if (
      callee?.language === "python" &&
      definition.kind === "method" &&
      /^(?:self|cls)$/.test(params[0] ?? "")
    ) {
      params = params.slice(1);
    }
    let position = 0;
    for (const arg of call.arguments) {
      if (arg.spread) continue;
      const name = arg.keyword ?? params[position++];
      if (name === undefined) continue;
      bindings.set(name, {
        inputs: inputsOf(arg.value, file.facts, call.scope, limited),
        host: hostInputs(arg.value, file.facts, call.scope, limited),
      });
    }
    return bindings;
  }

  sinkEffect(
    file: ProjectFile,
    call: CallFact,
    sink: Sink,
    location: Location,
    limitedFor: (kind: CapabilityKind) => ReadonlySet<string> | undefined = () => undefined,
  ): Capability {
    const facts = file.facts;
    let kind = sink.kind;
    if (sink.mode !== undefined) {
      const [mode] = select(call.arguments, facts, sink.mode);
      if (/[wax+]/.test(literalString(mode, facts) ?? "r")) kind = "file_write";
    }
    const limited = limitedFor(kind);
    let values: Value[] = sink.input === undefined ? [] : select(call.arguments, facts, sink.input);
    if (sink.chainInput) {
      const head = chainHead(facts, call);
      values = head === undefined ? [] : select(head.arguments, facts, "#0");
    }
    const partsOf = (items: Value[]) =>
      uniqueParts(items.flatMap((value) => inputsOf(value, facts, call.scope, limited)));
    const capability: Capability = {
      kind,
      target: call.ref?.name ?? call.callee,
      location,
      via: [],
      inputs: partsOf(values),
    };
    if (kind === "process") {
      if (
        sink.shell === true ||
        (typeof sink.shell === "string" && shellOption(call, facts, sink.shell))
      ) {
        capability.command = "shell";
      } else if (sink.quoted) {
        capability.command = "arguments";
      } else {
        // The program is the first item of an argument list, or the whole command otherwise.
        const [value] = values;
        const target = value === undefined ? undefined : deref(value, facts);
        const program =
          target?.kind === "list" ? partsOf(target.items.slice(0, 1)) : capability.inputs;
        capability.command = program.length > 0 ? "program" : "arguments";
        if (sink.args !== undefined) {
          const args =
            sink.args === "*"
              ? call.arguments
                  .filter((arg) => arg.keyword === null)
                  .slice(1)
                  .map((arg) => arg.value)
              : select(call.arguments, facts, sink.args);
          capability.inputs = uniqueParts([...capability.inputs, ...partsOf(args)]);
        }
      }
    }
    if (sink.query) capability.query = true;
    if ((kind === "network" || kind === "browser") && values[0] !== undefined) {
      const host = hostInputs(values[0], facts, call.scope, limited);
      if (host.length > 0) capability.host = host;
    }
    return capability;
  }

  /** A call that checks or narrows a value, with the parameters that value comes from. */
  guardOf(file: ProjectFile, call: CallFact): Guard | null {
    const name = call.ref?.name;
    if (name === undefined) return null;
    const kinds = compiledSinks()
      .guards.filter(({ pattern }) => pattern.test(name))
      .flatMap((guard) => guard.kinds);
    if (kinds.length === 0) return null;
    const params = new Set<string>();
    for (const arg of call.arguments) {
      for (const param of provenanceOf(arg.value, file.facts, call.scope).params) params.add(param);
    }
    return { name, kinds, params };
  }

  /** Reads of environment variables (`os.environ["KEY"]`, `process.env.KEY`) inside a function. */
  environmentReads(file: ProjectFile, scopes: Set<string>): Capability[] {
    const found: Capability[] = [];
    const visit = (value: Value, span: Span) => {
      switch (value.kind) {
        case "name":
          if (value.ref !== null && ENVIRONMENT.test(value.ref.name)) {
            found.push({
              kind: "secret",
              target: value.ref.name,
              location: locate(file.path, span),
              via: [],
              inputs: [],
            });
          }
          break;
        case "string":
          for (const part of value.template ?? []) visit(part, span);
          break;
        case "concat":
          for (const part of value.parts) visit(part, span);
          break;
        case "list":
          for (const item of value.items) visit(item, span);
          break;
        case "object":
          for (const entry of value.entries) visit(entry.value, span);
          break;
        default:
          break;
      }
    };
    for (const call of file.facts.calls) {
      if (!scopes.has(call.scope ?? MODULE_SCOPE)) continue;
      for (const arg of call.arguments) visit(arg.value, call.span);
    }
    for (const assignment of file.facts.assignments) {
      if (scopes.has(assignment.scope ?? MODULE_SCOPE)) visit(assignment.value, assignment.span);
    }
    for (const definition of file.facts.definitions) {
      if (!scopes.has(definition.id)) continue;
      for (const value of definition.returns ?? []) visit(value, definition.span);
    }
    return found;
  }
}

/**
 * A call whose target is chosen at run time, which tracing cannot follow: a callback
 * parameter (`on_done(result)`), a subscript (`handlers[name](args)`) or a call's result
 * (`getattr(tools, name)(args)`).
 */
function dynamicCall(file: ProjectFile, call: CallFact): boolean {
  const callee = call.callee.trim();
  if (/[\])]$/.test(callee)) return true;
  if (call.ref !== null || call.scope === null || !/^[A-Za-z_$][\w$]*$/.test(callee)) return false;
  return (
    file.facts.definitions
      .find((definition) => definition.id === call.scope)
      ?.params.includes(callee) === true
  );
}

/**
 * The guards that hold where `call` runs: same function, inside the guarded code, and
 * the checked value not assigned again in between.
 */
function limitsAt(facts: FileFacts, call: CallFact): GuardFact[] {
  return (facts.guards ?? []).filter(
    (guard) =>
      guard.scope === call.scope &&
      guard.subject.kind === "name" &&
      within(call.span, guard.region) &&
      !reassigned(facts, guard, call),
  );
}

const FILE_KINDS: ReadonlySet<CapabilityKind> = new Set(["file_read", "file_write", "file_delete"]);

/**
 * The checked values an effect of `kind` cannot be steered through: fixed alternatives
 * for every effect, and for a file path a name matching a pattern of letters, digits,
 * `_` and `-`, a value with neither `/` nor `..`, or a resolved path checked to start
 * with a fixed base.
 */
function safeSubjects(kind: CapabilityKind, guards: GuardFact[], facts: FileFacts): Set<string> {
  const safe = new Set<string>();
  const excluded = new Map<string, Set<string>>();
  const file = FILE_KINDS.has(kind);
  for (const guard of guards) {
    const subject = guard.subject.kind === "name" ? guard.subject.text : "";
    switch (guard.test) {
      case undefined:
        if (isFixed(guard.allowed, facts)) safe.add(subject);
        break;
      case "matches":
        if (file && namePattern(guard.allowed, facts)) safe.add(subject);
        break;
      case "excludes": {
        const text = literalString(guard.allowed, facts);
        if (!file || text === null) break;
        excluded.set(subject, new Set([...(excluded.get(subject) ?? []), text]));
        break;
      }
      case "within":
        if (
          file &&
          resolvedPath(guard.subject, facts) &&
          provenanceOf(guard.allowed, facts, guard.scope).params.size === 0
        )
          safe.add(subject);
        break;
    }
  }
  for (const [subject, texts] of excluded) if (texts.has("/") && texts.has("..")) safe.add(subject);
  return safe;
}

/**
 * A regular expression that admits only names: `^`, one class of letters, digits, `_`
 * and `-` (or `\w`, `\d`), a repetition and `$`. Such a name cannot hold `/`, `\` or `.`.
 */
function namePattern(value: Value, facts: FileFacts): boolean {
  const target = deref(value, facts);
  const compiled = target.kind === "call" ? facts.calls[target.call] : undefined;
  const pattern =
    literalString(value, facts) ??
    (compiled !== undefined && /(?:^|\.)compile$/.test(compiled.ref?.name ?? compiled.callee)
      ? literalString(compiled.arguments[0]?.value, facts)
      : null) ??
    (target.kind === "literal" ? (/^\/(.*)\/[a-z]*$/s.exec(target.text)?.[1] ?? null) : null);
  const match =
    pattern === null
      ? null
      : /^\^(\[[^\]]*\]|\\w|\\d)(?:[+*]|\{\d+(?:,\d*)?\})(?:\$|\\Z|\\z)$/.exec(pattern);
  const body = match?.[1];
  if (body === undefined) return false;
  if (!body.startsWith("[")) return true;
  const inner = body.slice(1, -1);
  return (
    !inner.startsWith("^") &&
    inner
      .replace(/\\[wd_-]/g, "")
      .replace(/[a-z]-[a-z]|[A-Z]-[A-Z]|[0-9]-[0-9]/g, "")
      .replace(/[\w-]/g, "") === ""
  );
}

/** Whether a value is a path made absolute: `p.resolve()`, `os.path.realpath(p)`, `path.resolve(BASE, name)`. */
function resolvedPath(value: Value, facts: FileFacts): boolean {
  const target = deref(value, facts);
  const call = target.kind === "call" ? facts.calls[target.call] : undefined;
  return (
    call !== undefined &&
    /(?:^|[.#])(?:resolve|realpath|realpathSync|abspath|normpath)$/.test(
      call.ref?.name ?? call.callee,
    )
  );
}

/**
 * The names in `call`'s function whose values come only from `safe` names and fixed
 * values, `safe` included: a variable built from a checked name is checked too.
 */
function coveredNames(facts: FileFacts, call: CallFact, safe: Set<string>): Set<string> {
  const names = new Set(safe);
  if (names.size === 0) return names;
  const at = position(call.span.line, call.span.column);
  const clean = new Map<string, boolean>();
  for (const assignment of facts.assignments) {
    const { target } = assignment;
    if (
      assignment.scope !== call.scope ||
      assignment.member !== undefined ||
      safe.has(target) ||
      !/^[\w$]+$/.test(target) ||
      position(assignment.span.line, assignment.span.column) >= at
    )
      continue;
    const provenance = provenanceOf(assignment.value, facts, call.scope, names);
    const fixed =
      provenance.params.size === 0 && provenance.requests.size === 0 && clean.get(target) !== false;
    clean.set(target, fixed);
    if (fixed) names.add(target);
    else names.delete(target);
  }
  return names;
}

function position(line: number, column: number): number {
  return line * 1e6 + column;
}

function within(span: Span, region: Span): boolean {
  const at = position(span.line, span.column);
  return (
    at >= position(region.line, region.column) && at <= position(region.endLine, region.endColumn)
  );
}

function reassigned(facts: FileFacts, guard: GuardFact, call: CallFact): boolean {
  const subject = guard.subject.kind === "name" ? guard.subject.text : "";
  const root = /^[\w$]+/.exec(subject)?.[0];
  const from = position(guard.region.line, guard.region.column);
  const to = position(call.span.line, call.span.column);
  return facts.assignments.some((assignment) => {
    const at = position(assignment.span.line, assignment.span.column);
    return (
      assignment.scope === guard.scope &&
      (assignment.target === root || assignment.target === subject) &&
      at >= from &&
      at < to
    );
  });
}

/** A URL's host as code reads it: `url.hostname`, `parsed.netloc`, `new URL(u).host`. */
const HOST_PART = /^(.+)\.(?:hostname|host|origin|netloc)$/;
const URL_PARSERS =
  /^(?:URL|urllib\.parse\.(?:urlparse|urlsplit)|(?:node:)?url#(?:parse|URL)|yarl\.URL|httpx\.URL)$/;

/**
 * The URLs whose host a guard's subject is: `url` for `url.hostname`, and the text
 * parsed into it (`urlparse(url).hostname`, `parsed = urlparse(url)`).
 */
function hostSources(subject: Value, facts: FileFacts): string[] {
  const value = deref(subject, facts);
  if (value.kind !== "name") return [];
  const base = HOST_PART.exec(value.text)?.[1];
  if (base === undefined) return [];
  const sources = [base];
  const holder: Value | undefined =
    value.of !== undefined
      ? { kind: "call", call: value.of }
      : value.base !== undefined
        ? facts.assignments[value.base]?.value
        : undefined;
  const parsed = holder === undefined ? undefined : deref(holder, facts);
  const parser = parsed?.kind === "call" ? facts.calls[parsed.call] : undefined;
  const [url] = parser?.arguments ?? [];
  if (url !== undefined && URL_PARSERS.test(parser?.ref?.name ?? ""))
    sources.push(dynamicPart(url.value, facts).text);
  return sources;
}

/**
 * Takes the parts of an effect's input that guards check where it runs out of the
 * caller's reach: a part computed from a call keeps the call, for model output
 * tracing, and loses where it comes from; any other part is dropped.
 */
function narrowed(
  effect: Capability,
  limits: GuardFact[],
  facts: FileFacts,
  call: CallFact,
): Capability {
  const names = coveredNames(facts, call, safeSubjects(effect.kind, limits, facts));
  const hosts = new Set(
    limits.flatMap((guard) =>
      guard.test === undefined && isFixed(guard.allowed, facts)
        ? hostSources(guard.subject, facts)
        : [],
    ),
  );
  const narrow = (parts: DynamicPart[], checked: (part: DynamicPart) => boolean) =>
    parts.flatMap((part) => {
      if (!checked(part)) return [part];
      if (part.calls === undefined) return [];
      const { from: _from, ...rest } = part;
      return [rest];
    });
  const covered = (part: DynamicPart) => names.has(part.text);
  const result: Capability = { ...effect, inputs: narrow(effect.inputs, covered) };
  if (effect.systemInputs !== undefined) result.systemInputs = narrow(effect.systemInputs, covered);
  if (effect.dataInputs !== undefined) result.dataInputs = narrow(effect.dataInputs, covered);
  if (effect.host !== undefined) {
    const host = narrow(effect.host, (part) => covered(part) || hosts.has(part.text));
    if (host.length > 0) result.host = host;
    else delete result.host;
  }
  return result;
}

/** Unknown/compound SQL stays conservative; a fixed SELECT is not a write. */
function sqlOperation(query: string | null): NonNullable<Capability["operation"]> {
  if (query === null) return "unknown";
  const sql = query
    .replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, "")
    .trim()
    .replace(/;\s*$/, "");
  if (
    /^(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|VACUUM|REINDEX|ATTACH|DETACH)\b/i.test(sql)
  )
    return "write";
  if (!sql.includes(";") && /^(?:SELECT|EXPLAIN)\b/i.test(sql)) return "read";
  return "unknown";
}

/** A shell option that is on, or set to something plenger cannot evaluate. */
function shellOption(call: CallFact, facts: FileFacts, path: string): boolean {
  const [value] = select(call.arguments, facts, path);
  if (value === undefined) return false;
  const target = deref(value, facts);
  if (target.kind === "literal")
    return !/^(?:False|false|None|null|undefined|0)$/.test(target.text);
  return true;
}

/** Adds the checks a function makes on the parameters an effect's input comes from. */
function withGuards(effect: Capability, guards: Guard[]): Capability {
  const params = new Set(effect.inputs.flatMap((part) => part.from ?? []));
  const names = guards
    .filter(
      (guard) =>
        guard.kinds.includes(effect.kind) && [...guard.params].some((param) => params.has(param)),
    )
    .map((guard) => guard.name);
  if (names.length === 0) return effect;
  return { ...effect, guards: [...new Set([...(effect.guards ?? []), ...names])] };
}

/**
 * Replaces inputs computed from parameters of the callee with what the caller passed
 * for those parameters; a parameter bound to a constant drops the input.
 */
function rebind(
  inputs: DynamicPart[],
  bindings: Map<string, Bound>,
  field: keyof Bound,
): DynamicPart[] {
  if (bindings.size === 0) return inputs;
  return uniqueParts(
    inputs.flatMap((part) => {
      const from = part.from ?? [];
      const bound = from.filter((name) => bindings.has(name));
      if (bound.length === 0) return [part];
      const parts = bound.flatMap((name) => bindings.get(name)?.[field] ?? []);
      const rest = from.filter((name) => !bindings.has(name));
      if (rest.length > 0) parts.push({ ...part, from: rest });
      return parts;
    }),
  );
}

/** The first call of a chain such as `Path(p).write_text(...)`: same start, shortest span. */
function chainHead(facts: FileFacts, call: CallFact): CallFact | undefined {
  return callsStartingAt(facts, call.span)
    .flatMap((index) => facts.calls[index] ?? [])
    .filter((candidate) => candidate !== call)
    .sort((a, b) => a.span.endLine - b.span.endLine || a.span.endColumn - b.span.endColumn)[0];
}

/**
 * Non-constant parts of an effect's input; for a command list, of each item. Names in
 * `limited` are values a guard checked where the effect runs (see `provenanceOf`).
 */
export function inputsOf(
  value: Value,
  facts: FileFacts,
  scope: string | null,
  limited?: ReadonlySet<string>,
): DynamicPart[] {
  const summary = summarizeText(value, facts, scope, limited);
  if (summary !== null) return summary.dynamic;
  const target = deref(value, facts);
  if (target.kind === "list")
    return target.items.flatMap((item) => inputsOf(item, facts, scope, limited));
  if (target.kind === "name" || target.kind === "call")
    return [dynamicPart(target, facts, scope, limited)];
  if (target.kind === "other") {
    // `args[0]`, `cmd or "ls"`: an input when it comes from somewhere plenger can name.
    const part = dynamicPart(target, facts, scope, limited);
    return part.from !== undefined || part.calls !== undefined ? [part] : [];
  }
  return [];
}

/**
 * The inputs that decide a URL's scheme and host. A URL whose fixed start already
 * names a host (`https://api.example.com/...`) or is relative (`/api/...`) has none;
 * otherwise the first interpolated value decides it, and a URL that is one value is
 * decided entirely by it.
 */
function hostInputs(
  value: Value,
  facts: FileFacts,
  scope: string | null,
  limited?: ReadonlySet<string>,
): DynamicPart[] {
  const summary = summarizeText(value, facts, scope, limited);
  if (summary === null) return inputsOf(value, facts, scope, limited);
  const first = summary.text.search(/\$?\{/);
  const prefix = first === -1 ? summary.text : summary.text.slice(0, first);
  if (prefix.startsWith("/") || /^[a-z][\w+.-]*:\/\/[^/?#@]+[/?#]/i.test(prefix)) return [];
  if (prefix !== "" && !/^[a-z][\w+.-]*:\/\/[^/?#]*$/i.test(prefix)) return [];
  return summary.dynamic.slice(0, 1);
}

function locate(path: string, span: Span): Location {
  return { path, ...span };
}

/** Drops repeated capabilities: same kind, target, location and providing tool. */
export function unique(capabilities: Capability[]): Capability[] {
  const seen = new Set<string>();
  return capabilities.filter((capability) => {
    const id = `${capability.kind}|${capability.target}|${locationKey(capability.location)}|${capability.tool ?? ""}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Drops repeated input parts: same source, text and origin. (The inventory detector's
 * `uniqueParts` keys on source and text only; the two are kept apart on purpose.)
 */
export function uniqueParts(parts: DynamicPart[]): DynamicPart[] {
  const seen = new Set<string>();
  return parts.filter((part) => {
    const id = `${part.source}:${part.text}:${part.from?.join(",") ?? ""}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
