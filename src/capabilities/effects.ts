/**
 * Following a project function down to calls with an outside effect: sinks from the
 * catalog, SQLite statements, environment reads, and the effects of the project
 * functions it calls, with the caller's arguments bound to the callee's parameters.
 */

import type { CallFact, FileFacts, Span, Value } from "../facts/model.ts";
import {
  callsStartingAt,
  type DynamicPart,
  definitionOf,
  deref,
  dynamicPart,
  literalString,
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
    const name = call.ref?.name;
    if (name !== undefined && call.ref?.kind !== "local") {
      const sqlite = this.sqliteEffect(file, call, location);
      if (sqlite !== null) effects.push(sqlite);
      const match = sinksFor(file.language).find(({ pattern }) => pattern.test(name));
      if (match !== undefined) effects.push(this.sinkEffect(file, call, match.sink, location));
    }
    const target = this.#index.calledFunction(file, call);
    const visit = this.#tracing.at(-1);
    if (target === null) {
      if (visit !== undefined && effects.length === 0 && dynamicCall(file, call))
        visit.dynamic.set(locationKey(location), location);
    } else if (depth + 1 > MAX_DEPTH && !this.#memo.has(`${target.path}|${target.definition}`)) {
      visit?.depthLimited.set(locationKey(location), location);
    } else {
      visit?.callees.add(`${target.path}|${target.definition}`);
      const bindings = this.bindArguments(file, call, target);
      for (const effect of this.effects(target.path, target.definition, depth + 1)) {
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
    return effects;
  }

  /** Preparing SQL does not execute it; bind data separately from the SQL text. */
  sqliteEffect(file: ProjectFile, call: CallFact, location: Location): Capability | null {
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
      inputs: uniqueParts(queries.flatMap((value) => inputsOf(value, file.facts, call.scope))),
      dataInputs: uniqueParts(data.flatMap((value) => inputsOf(value, file.facts, call.scope))),
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
        inputs: inputsOf(arg.value, file.facts, call.scope),
        host: hostInputs(arg.value, file.facts, call.scope),
      });
    }
    return bindings;
  }

  sinkEffect(file: ProjectFile, call: CallFact, sink: Sink, location: Location): Capability {
    const facts = file.facts;
    let kind = sink.kind;
    if (sink.mode !== undefined) {
      const [mode] = select(call.arguments, facts, sink.mode);
      if (/[wax+]/.test(literalString(mode, facts) ?? "r")) kind = "file_write";
    }
    let values: Value[] = sink.input === undefined ? [] : select(call.arguments, facts, sink.input);
    if (sink.chainInput) {
      const head = chainHead(facts, call);
      values = head === undefined ? [] : select(head.arguments, facts, "#0");
    }
    const partsOf = (items: Value[]) =>
      uniqueParts(items.flatMap((value) => inputsOf(value, facts, call.scope)));
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
      const host = hostInputs(values[0], facts, call.scope);
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

/** Non-constant parts of an effect's input; for a command list, of each item. */
export function inputsOf(value: Value, facts: FileFacts, scope: string | null): DynamicPart[] {
  const summary = summarizeText(value, facts, scope);
  if (summary !== null) return summary.dynamic;
  const target = deref(value, facts);
  if (target.kind === "list") return target.items.flatMap((item) => inputsOf(item, facts, scope));
  if (target.kind === "name" || target.kind === "call") return [dynamicPart(target, facts, scope)];
  if (target.kind === "other") {
    // `args[0]`, `cmd or "ls"`: an input when it comes from somewhere plenger can name.
    const part = dynamicPart(target, facts, scope);
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
function hostInputs(value: Value, facts: FileFacts, scope: string | null): DynamicPart[] {
  const summary = summarizeText(value, facts, scope);
  if (summary === null) return inputsOf(value, facts, scope);
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
