/**
 * Following a project function down to calls with an outside effect: sinks from the
 * catalog, SQLite statements, environment reads, and the effects of the project
 * functions it calls, with the caller's arguments bound to the callee's parameters.
 */

import type {
  CallFact,
  DefinitionFact,
  FileFacts,
  GuardFact,
  Span,
  Value,
} from "../facts/model.ts";
import {
  callsStartingAt,
  type DynamicPart,
  definitionOf,
  deref,
  dynamicPart,
  type Flow,
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
import { PathValues, staysInDirectory } from "./names.ts";
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

/**
 * How values are read for an effect. `file`: a file name with no separators that is
 * never `.` or `..` carries nothing (see `PathValues.nameLevel`). `other`: as written.
 */
type FlowMode = "file" | "other";

/** What a project function's return value is computed from: its parameters and request globals. */
interface ReturnFlow {
  params: ReadonlySet<string>;
  requests: readonly string[];
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
  readonly #confined = new Map<string, boolean>();
  readonly #flows = new WeakMap<ProjectFile, Map<FlowMode, Flow>>();
  readonly #paths: PathValues;
  readonly #returnFlows = new Map<string, ReturnFlow | null>();
  readonly #checked = new Map<string, Set<string>>();

  constructor(project: Project, index: ProjectIndex, inventory: Inventory) {
    this.#project = project;
    this.#index = index;
    this.#paths = new PathValues(project, index);
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
    const flowOf = (kind: CapabilityKind) =>
      this.flowFor(file, FILE_KINDS.has(kind) ? "file" : "other");
    const safeFor = (kind: CapabilityKind) => this.safeNames(file, kind, limits);
    const checked = new Map<boolean, ReadonlySet<string> | undefined>();
    const limitedFor = (kind: CapabilityKind) => {
      const forFile = FILE_KINDS.has(kind);
      if (!checked.has(forFile))
        checked.set(
          forFile,
          limits.length === 0
            ? undefined
            : coveredNames(file.facts, call, safeFor(kind), flowOf(kind)),
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
      if (name === undefined) continue;
      const local = callee.ref?.kind === "local";
      const sqlite = local
        ? null
        : this.sqliteEffect(file, callee, location, limitedFor("database"));
      if (sqlite !== null) effects.push(sqlite);
      const match = sinksFor(file.language).find(
        ({ pattern, sink }) => (!local || sink.projectClasses === true) && pattern.test(name),
      );
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
      const fileBindings = this.bindArguments(file, call, target, limitedFor("file_write"), "file");
      const otherBindings = this.bindArguments(file, call, target, limitedFor("process"));
      const argumentBindings = this.bindArguments(
        file,
        call,
        target,
        limitedFor("process"),
        "arguments",
      );
      for (const effect of this.effects(target.path, target.definition, depth + 1)) {
        const bindings = FILE_KINDS.has(effect.kind) ? fileBindings : otherBindings;
        const bound: Capability = {
          ...effect,
          via: [location, ...effect.via],
          inputs:
            effect.kind === "process" && effect.command !== "shell"
              ? argumentInputs(effect, argumentBindings, otherBindings)
              : rebind(effect.inputs, bindings, "inputs"),
        };
        if (effect.systemInputs !== undefined)
          bound.systemInputs = rebind(effect.systemInputs, bindings, "inputs");
        if (effect.dataInputs !== undefined)
          bound.dataInputs = rebind(effect.dataInputs, bindings, "inputs");
        if (effect.program !== undefined)
          bound.program = rebind(effect.program, bindings, "inputs");
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
      : effects.map((effect) =>
          narrowed(effect, limits, file.facts, call, safeFor, flowOf(effect.kind)),
        );
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
        queries.flatMap((value) =>
          inputsOf(value, file.facts, call.scope, limited, this.flowFor(file)),
        ),
      ),
      dataInputs: uniqueParts(
        data.flatMap((value) =>
          inputsOf(value, file.facts, call.scope, limited, this.flowFor(file)),
        ),
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
    mode: "file" | "arguments" | "other" = "other",
  ): Map<string, Bound> {
    const bindings = new Map<string, Bound>();
    const flow = this.flowFor(file, mode === "file" ? "file" : "other");
    for (const [name, value] of this.boundValues(file, call, target)) {
      const inputs = inputsOf(value, file.facts, call.scope, limited, flow);
      // A confined path, or an absolute path among a program's arguments, carries nothing.
      const checked =
        (mode === "file" && this.confinedPath(file, value)) ||
        (mode === "arguments" && this.#paths.absolute(file, value));
      bindings.set(name, {
        inputs: checked ? inputs.flatMap(withoutOrigin) : inputs,
        host: hostInputs(value, file.facts, call.scope, limited, this.flowFor(file)),
      });
    }
    return bindings;
  }

  /**
   * The value `call` gives each parameter it binds: by position or keyword, or, for a
   * JS function that unpacks its parameters (`({ uri, options }) => ...`), the entries of
   * an object literal passed to it, by key.
   */
  boundValues(
    file: ProjectFile,
    call: CallFact,
    target: { path: string; definition: string },
  ): [string, Value][] {
    const callee = this.#project.files.get(target.path);
    const definition =
      callee === undefined ? undefined : definitionOf(callee.facts, target.definition);
    if (definition?.destructured !== true)
      return this.argumentParams(call, target).flatMap((name, index) => {
        const arg = call.arguments[index];
        return name === undefined || arg === undefined
          ? []
          : [[name, arg.value] as [string, Value]];
      });
    const params = new Set(definition.params);
    return call.arguments.flatMap((arg) => {
      const object = deref(arg.value, file.facts);
      if (arg.spread || object.kind !== "object") return [];
      return object.entries.flatMap((entry) =>
        entry.key !== null && params.has(entry.key)
          ? [[entry.key, entry.value] as [string, Value]]
          : [],
      );
    });
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
      // The path the method acts on: the first call of its chain (`Path(p).read_text()`),
      // the expression it is called on (`(BASE / p).read_text()`), or the variable's value.
      const head = chainHead(facts, call);
      const holder = call.receiver === undefined ? undefined : facts.assignments[call.receiver];
      values =
        head !== undefined
          ? select(head.arguments, facts, "#0")
          : call.object !== undefined
            ? [call.object]
            : holder !== undefined && holder.member === undefined && call.receiver !== undefined
              ? // The variable itself, so a guard that checked it applies.
                [{ kind: "name", text: holder.target, ref: null, assignment: call.receiver }]
              : [];
    }
    const fileFlow = this.flowFor(file, FILE_KINDS.has(kind) ? "file" : "other");
    // A name that may be `..` still cannot be read or written as a file when it ends the
    // path: `..` there is a directory. Deletes, copies and moves get no such allowance.
    const last =
      (kind === "file_read" || kind === "file_write") && !MOVES.test(call.ref?.name ?? call.callee)
        ? values.flatMap((value) => {
            const component = lastComponent(value, facts, file.language === "python");
            return component !== undefined && this.#paths.nameLevel(file, component) === "plain"
              ? [component]
              : [];
          })
        : [];
    const sinkFlow: Flow =
      last.length === 0
        ? fileFlow
        : {
            call: (inner) => fileFlow.call(inner),
            fixed: (value) => last.includes(value) || fileFlow.fixed?.(value) === true,
          };
    const partsOf = (items: Value[]) =>
      uniqueParts(
        items.flatMap((value) => {
          const parts = inputsOf(value, facts, call.scope, limited, sinkFlow);
          return FILE_KINDS.has(kind) && this.confinedPath(file, value)
            ? parts.flatMap(withoutOrigin)
            : parts;
        }),
      );
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
        const listed = target?.kind === "list" ? target.items : undefined;
        // An absolute path among the arguments cannot be read as an option.
        const argumentParts = (items: Value[]) =>
          partsOf(
            items
              .flatMap((item) => {
                const resolved = deref(item, facts);
                return resolved.kind === "list" ? resolved.items : [item];
              })
              .filter((item) => !this.#paths.absolute(file, item)),
          );
        const program = listed !== undefined ? partsOf(listed.slice(0, 1)) : capability.inputs;
        capability.command = program.length > 0 ? "program" : "arguments";
        if (program.length > 0) capability.program = program;
        if (listed !== undefined)
          capability.inputs = uniqueParts([...program, ...argumentParts(listed.slice(1))]);
        if (sink.args !== undefined) {
          const args =
            sink.args === "*"
              ? call.arguments
                  .filter((arg) => arg.keyword === null)
                  .slice(1)
                  .map((arg) => arg.value)
              : select(call.arguments, facts, sink.args);
          capability.inputs = uniqueParts([...capability.inputs, ...argumentParts(args)]);
        }
      }
    }
    if (sink.query) capability.query = true;
    if (sink.template) capability.template = true;
    if ((kind === "network" || kind === "browser") && values[0] !== undefined) {
      const host = hostInputs(values[0], facts, call.scope, limited, this.flowFor(file));
      if (host.length > 0) capability.host = host;
    }
    return capability;
  }

  /**
   * Whether a value is a path that a project function confines before returning it:
   * `report_path(name)`, where `report_path` resolves the path and checks it stays
   * inside a base, or builds it without its arguments, directly or through another such
   * function, or `Path()` or `str()` of one. The base may come from the function's
   * parameters (`safe_join(base, name)`).
   */
  confinedPath(file: ProjectFile, value: Value, depth = 0): boolean {
    const target = deref(value, file.facts);
    const call = target.kind === "call" ? file.facts.calls[target.call] : undefined;
    if (call === undefined || depth > MAX_DEPTH) return false;
    const [inner] = call.arguments;
    if (PATH_WRAPPER.test(call.ref?.name ?? call.callee) && call.arguments.length === 1)
      return inner !== undefined && this.confinedPath(file, inner.value, depth + 1);
    // `safe_join(base, name)` returns a path inside `base`, or None.
    if (SAFE_JOIN.test(call.ref?.name ?? "")) return true;
    const callee = this.#index.calledFunction(file, call);
    return callee !== null && this.confinedReturn(callee.path, callee.definition, depth + 1);
  }

  /** Whether every value a project function returns is a confined path (see `confinedPath`). */
  confinedReturn(path: string, definition: string, depth: number): boolean {
    const key = `${path}|${definition}`;
    const cached = this.#confined.get(key);
    if (cached !== undefined) return cached;
    // A function that reaches itself again is not taken to confine anything.
    this.#confined.set(key, false);
    const file = this.#project.files.get(path);
    const returns = file === undefined ? [] : (definitionOf(file.facts, definition)?.returns ?? []);
    if (file === undefined || returns.length === 0) return false;
    const guards = (file.facts.guards ?? []).filter(
      (guard) =>
        guard.scope === definition && (guard.subject.kind === "name" || guard.test === "call"),
    );
    const safe = this.safeNames(file, "file_read", guards, true);
    const result = returns.every((value) => {
      const provenance = provenanceOf(
        value,
        file.facts,
        definition,
        safe,
        this.flowFor(file, "file"),
      );
      if (provenance.params.size === 0 && provenance.requests.size === 0) return true;
      return this.confinedPath(file, value, depth);
    });
    this.#confined.set(key, result);
    return result;
  }

  /**
   * The parameter of the called function each argument of `call` is bound to: by keyword
   * or position, after a Python method's `self`. Undefined where plenger cannot tell:
   * a spread, an extra or unknown keyword, or a JS function that unpacks its parameters.
   */
  argumentParams(
    call: CallFact,
    target: { path: string; definition: string },
  ): (string | undefined)[] {
    const callee = this.#project.files.get(target.path);
    const definition =
      callee === undefined ? undefined : definitionOf(callee.facts, target.definition);
    if (definition === undefined || definition.destructured)
      return call.arguments.map(() => undefined);
    const params = calleeParams(definition, callee?.language === "python");
    const named = new Set(params);
    let position = 0;
    return call.arguments.map((arg) => {
      if (arg.spread) return undefined;
      if (arg.keyword !== null) return named.has(arg.keyword) ? arg.keyword : undefined;
      return params[position++];
    });
  }

  /** What tracing knows of values in a file for effects of `mode` (see `FlowMode`). */
  flowFor(file: ProjectFile, mode: FlowMode = "other"): Flow {
    const modes = this.#flows.get(file) ?? new Map<FlowMode, Flow>();
    this.#flows.set(file, modes);
    const known = modes.get(mode);
    if (known !== undefined) return known;
    const flow: Flow = {
      call: (call) => {
        const target = this.#index.calledFunction(file, call);
        // A row a database lookup returns does not carry the values it was found by.
        if (target === null && ROW_LOOKUP.test(call.ref?.name ?? call.callee))
          return { args: new Set(), requests: [], chain: false };
        const summary =
          target === null ? null : this.returnFlow(target.path, target.definition, mode);
        if (target === null || summary === null) return null;
        const args = new Set<number>();
        for (const [index, name] of this.argumentParams(call, target).entries())
          if (name === undefined || summary.params.has(name)) args.add(index);
        return { args, requests: summary.requests };
      },
    };
    if (mode === "file")
      flow.fixed = (value) =>
        staysInDirectory(this.#paths.nameLevel(file, value)) ||
        this.#paths.componentsStay(file, value);
    modes.set(mode, flow);
    return flow;
  }

  /**
   * The parameters and request globals a project function's return values are computed
   * from, or null when plenger cannot tell: a class, no recorded or too many returns
   * (a generator, ten or more), or a function that reaches itself again.
   */
  returnFlow(path: string, definition: string, mode: FlowMode = "other"): ReturnFlow | null {
    const key = `${path}|${definition}|${mode}`;
    if (this.#returnFlows.has(key)) return this.#returnFlows.get(key) ?? null;
    this.#returnFlows.set(key, null);
    const file = this.#project.files.get(path);
    const fact = file === undefined ? undefined : definitionOf(file.facts, definition);
    const returns = fact?.returns;
    if (
      file === undefined ||
      fact?.kind === "class" ||
      returns === undefined ||
      returns.length >= 10
    )
      return null;
    const params = new Set<string>();
    const requests = new Set<string>();
    for (const value of returns) {
      const provenance = provenanceOf(
        value,
        file.facts,
        definition,
        undefined,
        this.flowFor(file, mode),
      );
      for (const param of provenance.params) params.add(param);
      for (const request of provenance.requests) requests.add(request);
    }
    const result = { params, requests: [...requests] };
    this.#returnFlows.set(key, result);
    return result;
  }

  /**
   * Names an effect of `kind` cannot be steered through where `limits` hold: the checked
   * values of `safeSubjects`, and the arguments a check helper the test calls confines
   * (`if not is_within(BASE, path): raise`).
   */
  safeNames(
    file: ProjectFile,
    kind: CapabilityKind,
    limits: GuardFact[],
    parameterBases = false,
  ): Set<string> {
    const safe = safeSubjects(kind, limits, file.facts, parameterBases);
    for (const guard of limits)
      if (guard.test === "call")
        for (const name of this.helperChecked(file, guard.subject, kind)) safe.add(name);
    return safe;
  }

  /** The names passed to a check helper (`isWithin(BASE, inputPath)`) for parameters it checks. */
  helperChecked(file: ProjectFile, value: Value, kind: CapabilityKind, depth = 0): string[] {
    const call = value.kind === "call" ? file.facts.calls[value.call] : undefined;
    const target = call === undefined ? null : this.#index.calledFunction(file, call);
    if (call === undefined || target === null || depth > MAX_DEPTH) return [];
    const checked = this.checkedParams(target.path, target.definition, kind, depth + 1);
    const names: string[] = [];
    for (const [index, param] of this.argumentParams(call, target).entries()) {
      const arg = call.arguments[index]?.value;
      if (param !== undefined && checked.has(param) && arg?.kind === "name") names.push(arg.text);
    }
    return names;
  }

  /**
   * The parameters a function checks whenever it returns a true value, for an effect of
   * `kind`: what its returned tests and the guards around those returns limit, followed
   * back through resolving calls (`path.resolve(inner)`, `os.path.relpath(p, BASE)`) to a
   * parameter. A base may come from the function's parameters.
   */
  checkedParams(
    path: string,
    definition: string,
    kind: CapabilityKind,
    depth: number,
  ): Set<string> {
    const key = `${path}|${definition}|${FILE_KINDS.has(kind)}`;
    const cached = this.#checked.get(key);
    if (cached !== undefined) return cached;
    const result = new Set<string>();
    this.#checked.set(key, result);
    const file = this.#project.files.get(path);
    const fact = file === undefined ? undefined : definitionOf(file.facts, definition);
    if (file === undefined || fact === undefined) return result;
    const guards: GuardFact[] = (fact.checks ?? []).map((check) => ({
      ...check,
      scope: definition,
      region: fact.span,
    }));
    const safe = safeSubjects(kind, guards, file.facts, true);
    for (const guard of guards) {
      if (guard.test === "call")
        for (const name of this.helperChecked(file, guard.subject, kind, depth)) safe.add(name);
    }
    for (const guard of guards) {
      if (guard.subject.kind !== "name" && guard.test !== "call") continue;
      const subjects =
        guard.test === "call"
          ? (
              file.facts.calls[guard.subject.kind === "call" ? guard.subject.call : -1]
                ?.arguments ?? []
            )
              .map((arg) => arg.value)
              .filter((arg) => arg.kind === "name" && safe.has(arg.text))
          : safe.has(guard.subject.kind === "name" ? guard.subject.text : "")
            ? [guard.subject]
            : [];
      for (const subject of subjects) {
        const param = checkedParam(subject, file.facts, fact);
        if (param !== null) result.add(param);
      }
    }
    return result;
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
      (guard.subject.kind === "name" || guard.test === "call") &&
      within(call.span, guard.region) &&
      !reassigned(facts, guard, call),
  );
}

const FILE_KINDS: ReadonlySet<CapabilityKind> = new Set(["file_read", "file_write", "file_delete"]);

/**
 * The checked values an effect of `kind` cannot be steered through: fixed alternatives
 * for every effect, and for a file path a name matching a pattern of letters, digits,
 * `_` and `-`, a value with neither `..` nor `/` (or with no `..` and not absolute),
 * or a resolved path checked to lie in
 * a fixed base: `is_relative_to`, or a prefix that ends with a separator, since
 * `/srv/notes_old` starts with `/srv/notes`.
 */
function safeSubjects(
  kind: CapabilityKind,
  guards: GuardFact[],
  facts: FileFacts,
  parameterBases = false,
): Set<string> {
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
      case "relative":
        if (file) excluded.set(subject, new Set([...(excluded.get(subject) ?? []), "<relative>"]));
        break;
      case "descends":
      case "differs": {
        // Only the result of `path.relative` stays inside its base when it does not climb.
        const text =
          guard.test === "descends"
            ? climbPrefix(guard.allowed, facts)
            : literalString(guard.allowed, facts);
        if (!file || relativeTarget(guard.subject, facts) === null || text === null) break;
        const marker = guard.test === "differs" ? `!${text}` : `^${text}`;
        excluded.set(subject, new Set([...(excluded.get(subject) ?? []), marker]));
        break;
      }
      case "within":
      case "inside":
        if (
          file &&
          resolvedPath(guard.subject, facts) &&
          (guard.test === "inside" || endsWithSeparator(guard.allowed, facts)) &&
          fixedBase(provenanceOf(guard.allowed, facts, guard.scope), parameterBases)
        )
          safe.add(subject);
        break;
    }
  }
  for (const [subject, texts] of excluded) {
    // `rel` from `path.relative(BASE, p)`: not absolute, and starting with neither `..`
    // nor `../`, or not `..` itself.
    const climbs = texts.has("^..") || (texts.has("^../") && texts.has("!.."));
    if (texts.has("..") && (texts.has("/") || texts.has("<relative>"))) safe.add(subject);
    else if (climbs && texts.has("<relative>")) safe.add(subject);
  }
  return safe;
}

/** Relative-path calls: `path.relative(from, to)` and `os.path.relpath(path, start)`. */
const RELATIVE = /(?:^|[.#])(?:relative|relpath)$/;

/**
 * The path a relative-path call measures (`to` in `path.relative(from, to)`, `path` in
 * `os.path.relpath(path, start)`), or null when the value is not one.
 */
function relativeTarget(value: Value, facts: FileFacts): Value | null {
  const target = deref(value, facts);
  const call = target.kind === "call" ? facts.calls[target.call] : undefined;
  const name = call?.ref?.name ?? call?.callee ?? "";
  if (call === undefined || !RELATIVE.test(name)) return null;
  const index = name.endsWith("relpath") ? 0 : 1;
  return call.arguments[index]?.value ?? null;
}

/** `..` or `../` for a prefix test (`rel.startsWith(`..${path.sep}`)`), or null. */
function climbPrefix(value: Value, facts: FileFacts): string | null {
  const target = deref(value, facts);
  if (target.kind !== "string") return null;
  if (target.value === "..") return "..";
  return /^\.\.(?:[/\\]|\$?\{(?:os\.|path\.)?sep\})$/.test(target.value) ? "../" : null;
}

/**
 * The parameter a checked value is, following resolving calls and relative-path calls
 * (`path.relative(BASE, path.resolve(inner))` is `inner`), or null.
 */
function checkedParam(value: Value, facts: FileFacts, definition: DefinitionFact): string | null {
  let current: Value | null = value;
  for (let depth = 0; current !== null && depth < 8; depth++) {
    if (current.kind === "name" && current.param) {
      const root = /^[\w$]+/.exec(current.text)?.[0] ?? "";
      return definition.params.includes(root) && root === current.text ? root : null;
    }
    const measured = relativeTarget(current, facts);
    if (measured !== null) {
      current = measured;
      continue;
    }
    const target = deref(current, facts);
    const call = target.kind === "call" ? facts.calls[target.call] : undefined;
    if (call === undefined) return null;
    const name = call.ref?.name ?? call.callee;
    const [only] = call.arguments;
    const single = call.arguments.length === 1 && only !== undefined;
    if (single && (RESOLVING.test(name) || PATH_WRAPPER.test(name))) current = only.value;
    else if (call.arguments.length === 0 && call.object !== undefined && RESOLVING.test(name))
      current = call.object;
    else return null;
  }
  return null;
}

/** Calls that make a path absolute without moving it: `resolve`, `realpath`, `abspath`, `normpath`. */
const RESOLVING = /(?:^|[.#])(?:resolve|realpath|realpathSync|abspath|normpath)$/;

/** A function's parameters as callers fill them: a Python method's `self` or `cls` left out. */
function calleeParams(definition: DefinitionFact, python: boolean): string[] {
  const params = definition.params;
  return python && definition.kind === "method" && /^(?:self|cls)$/.test(params[0] ?? "")
    ? params.slice(1)
    : params;
}

/** A base that does not come from the caller, or, when `parameters`, comes at most from the function's parameters. */
function fixedBase(provenance: ReturnType<typeof provenanceOf>, parameters: boolean): boolean {
  return provenance.requests.size === 0 && (parameters || provenance.params.size === 0);
}

/**
 * Database lookups that return stored rows: SQLAlchemy queries and session reads, Django
 * managers, Prisma reads, and the `findById`-style methods of Mongoose and Sequelize.
 */
const ROW_LOOKUP =
  /(?:\.query\(\)(?:\.\w+\(\))*\.(?:first|one|one_or_none|scalar|all|get|get_or_404|first_or_404)|(?:^|\.)session\.get|\.execute\(\)(?:\.\w+\(\))*\.(?:first|one|one_or_none|scalar|scalar_one|scalar_one_or_none|all|fetchone|fetchall)|\.objects(?:\.\w+\(\))*\.(?:get|first|last|all|filter|exclude|values|values_list)|#PrismaClient\(\)\.\w+\.(?:findUnique|findFirst|findMany|findUniqueOrThrow|findFirstOrThrow)|\.(?:findById|findOne|findAll|findByPk))$/;

/** Library joins that refuse a result outside their base: werkzeug's and Flask's `safe_join`. */
const SAFE_JOIN = /^(?:werkzeug\.(?:security|utils)|flask(?:\.helpers)?)\.safe_join$/;

/** File calls that copy, move or link: a directory as their target takes the file in. */
const MOVES =
  /(?:copy|copy2|copyfile|copytree|copyFile|copyFileSync|cp|cpSync|move|rename|renameSync|replace|symlink|symlink_to|link|ensureDir)$/;

/** Calls that make a path absolute or normal without changing its last component. */
const WRAPS_PATH =
  /(?:^|[.#])(?:abspath|realpath|normpath|normalize|resolve|fspath)$|^(?:str|String)$/;

/** Calls that join path components: `os.path.join`, `path.join`, `path.resolve`, `joinpath`. */
const JOINS = /(?:^|[.#])(?:join|resolve|joinpath)$/;

/**
 * The value that is the last component of a path built by joining (`os.path.join(BASE,
 * name)`, `BASE / name`, `` `${dir}/${name}` ``), or undefined.
 */
function lastComponent(
  value: Value,
  facts: FileFacts,
  python: boolean,
  depth = 0,
): Value | undefined {
  const target = deref(value, facts);
  if (target.kind === "call") {
    const call = facts.calls[target.call];
    const args = call?.arguments ?? [];
    // `os.path.abspath(os.path.join(BASE, name))` ends with the same component.
    const single = args.length === 1 ? args[0] : undefined;
    if (
      call !== undefined &&
      single !== undefined &&
      depth < 4 &&
      WRAPS_PATH.test(call.ref?.name ?? call.callee)
    )
      return lastComponent(single.value, facts, python, depth + 1);
    if (call === undefined || args.length < 2 || args.some((arg) => arg.spread)) return undefined;
    return JOINS.test(call.ref?.name ?? call.callee) ? args.at(-1)?.value : undefined;
  }
  if (target.kind === "other" && python && / \/ /.test(target.text) && target.parts !== undefined)
    return target.parts.length === 2 ? target.parts[1] : undefined;
  if (target.kind === "string" && target.template !== undefined && target.template.length > 0) {
    const ending = python ? /\/\{[^{}]*\}$/ : /\/\$\{[^{}]*\}$/;
    return ending.test(target.value) ? target.template.at(-1) : undefined;
  }
  return undefined;
}

/** Calls that only change a path's type: `Path(p)`, `str(p)`, `os.fspath(p)`, `String(p)`. */
const PATH_WRAPPER = /^(?:(?:pathlib\.)?(?:Pure|Posix|Windows)?Path|str|os\.fspath|String)$/;

/**
 * An input part whose value a check confines: a part computed from a call keeps the
 * call, for model output tracing, and loses where it comes from; any other is dropped.
 */
function withoutOrigin(part: DynamicPart): DynamicPart[] {
  if (part.calls === undefined) return [];
  const { from: _from, ...rest } = part;
  return [rest];
}

/** Path separators as code names them: `os.sep`, `os.path.sep`, `path.sep`. */
const SEPARATOR = /(?:^|[.#])sep$/;

/** Whether a base ends with a path separator: `BASE + os.sep`, `NOTES + "/"`, `` `${NOTES}/` ``. */
function endsWithSeparator(value: Value, facts: FileFacts): boolean {
  const target = deref(value, facts);
  if (target.kind === "string") return /[/\\]$/.test(target.value);
  if (target.kind !== "concat") return false;
  const last = target.parts.at(-1);
  const tail = last === undefined ? undefined : deref(last, facts);
  return (
    (tail?.kind === "string" && /[/\\]$/.test(tail.value)) ||
    (tail?.kind === "name" && SEPARATOR.test(tail.ref?.name ?? tail.text))
  );
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

/**
 * Whether a value is a path made absolute: `p.resolve()`, `os.path.realpath(p)`,
 * `path.resolve(BASE, name)`, or `Path(...)` of one.
 */
function resolvedPath(value: Value, facts: FileFacts, depth = 0): boolean {
  const target = deref(value, facts);
  const call = target.kind === "call" ? facts.calls[target.call] : undefined;
  if (call === undefined || depth > 4) return false;
  const name = call.ref?.name ?? call.callee;
  if (/(?:^|[.#])(?:resolve|realpath|realpathSync|abspath|normpath)$/.test(name)) return true;
  const [inner] = call.arguments;
  return (
    /^(?:pathlib\.)?(?:Pure|Posix|Windows)?Path$/.test(name) &&
    inner !== undefined &&
    resolvedPath(inner.value, facts, depth + 1)
  );
}

/**
 * The names in `call`'s function whose values come only from `safe` names and fixed
 * values, `safe` included: a variable built from a checked name is checked too.
 */
function coveredNames(
  facts: FileFacts,
  call: CallFact,
  safe: Set<string>,
  flow?: Flow,
): Set<string> {
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
    const provenance = provenanceOf(assignment.value, facts, call.scope, names, flow);
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
  safeFor: (kind: CapabilityKind) => Set<string>,
  flow: Flow,
): Capability {
  const names = coveredNames(facts, call, safeFor(effect.kind), flow);
  const hosts = new Set(
    limits.flatMap((guard) =>
      guard.test === undefined && isFixed(guard.allowed, facts)
        ? hostSources(guard.subject, facts)
        : [],
    ),
  );
  const narrow = (parts: DynamicPart[], checked: (part: DynamicPart) => boolean) =>
    parts.flatMap((part) => (checked(part) ? withoutOrigin(part) : [part]));
  const covered = (part: DynamicPart) => names.has(part.text);
  const result: Capability = { ...effect, inputs: narrow(effect.inputs, covered) };
  if (effect.systemInputs !== undefined) result.systemInputs = narrow(effect.systemInputs, covered);
  if (effect.dataInputs !== undefined) result.dataInputs = narrow(effect.dataInputs, covered);
  if (effect.program !== undefined) result.program = narrow(effect.program, covered);
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
 * A program's inputs as the caller gives them: the parts that name the program bound as
 * usual, the arguments bound with absolute paths taken out (they cannot be options).
 */
function argumentInputs(
  effect: Capability,
  argumentBindings: Map<string, Bound>,
  otherBindings: Map<string, Bound>,
): DynamicPart[] {
  const key = (part: DynamicPart) => `${part.source}:${part.text}:${part.from?.join(",") ?? ""}`;
  const program = new Set((effect.program ?? []).map(key));
  return uniqueParts([
    ...rebind(
      effect.inputs.filter((part) => program.has(key(part))),
      otherBindings,
      "inputs",
    ),
    ...rebind(
      effect.inputs.filter((part) => !program.has(key(part))),
      argumentBindings,
      "inputs",
    ),
  ]);
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
  flow?: Flow,
): DynamicPart[] {
  const summary = summarizeText(value, facts, scope, limited, flow);
  if (summary !== null) return summary.dynamic;
  const target = deref(value, facts);
  if (target.kind === "list")
    return target.items.flatMap((item) => inputsOf(item, facts, scope, limited, flow));
  if (target.kind === "name" || target.kind === "call")
    return [dynamicPart(target, facts, scope, limited, flow)];
  if (target.kind === "other") {
    // `args[0]`, `cmd or "ls"`: an input when it comes from somewhere plenger can name.
    const part = dynamicPart(target, facts, scope, limited, flow);
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
  flow?: Flow,
): DynamicPart[] {
  const summary = summarizeText(value, facts, scope, limited, flow);
  if (summary === null) return inputsOf(value, facts, scope, limited, flow);
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
