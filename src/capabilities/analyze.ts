import type { Argument, CallFact, FileFacts, Span, Value } from "../facts/model.ts";
import type {
  Agent,
  Capability,
  CapabilityKind,
  DynamicPart,
  Inventory,
  LlmCall,
  Location,
  Prompt,
  Tool,
} from "../inventory/model.ts";
import { compilePatterns } from "../inventory/pattern.ts";
import {
  deref,
  dynamicPart,
  isEnabled,
  literalString,
  provenanceOf,
  select,
  summarizeText,
} from "../inventory/values.ts";
import type { Language } from "../languages.ts";
import type { Project, ProjectFile } from "../project/project.ts";
import {
  APPROVAL_CALLS,
  APPROVAL_OPTIONS,
  BUILTIN_TOOL_CAPABILITIES,
  GUARDS,
  JAVASCRIPT_SINKS,
  PYTHON_SINKS,
  type Sink,
} from "./sinks.ts";

/** How many project functions deep the analysis follows calls. */
const MAX_DEPTH = 6;
const ENVIRONMENT = /^(?:os\.environ|process\.env|import\.meta\.env)\.[\w$]+$/;
/** Stands for a file's module-level code where a definition id is expected. */
const MODULE = "<module>";
const INTERRUPT_OPTIONS = [
  "interrupt_before",
  "interrupt_after",
  "interruptBefore",
  "interruptAfter",
];
/** Effects that misbehave when their input is model output. */
const OUTPUT_SINKS = new Set<CapabilityKind>([
  "process",
  "code",
  "file_read",
  "file_write",
  "file_delete",
  "network",
  "database",
  "message",
  "payment",
  "deserialize",
  "browser",
]);

interface CompiledSink {
  sink: Sink;
  pattern: RegExp;
}

interface Guard {
  name: string;
  kinds: CapabilityKind[];
  /** Parameters the checked value comes from. */
  params: Set<string>;
}

let compiled:
  | {
      python: CompiledSink[];
      javascript: CompiledSink[];
      guards: { kinds: CapabilityKind[]; pattern: RegExp }[];
      approvals: RegExp;
    }
  | undefined;

function catalog() {
  compiled ??= {
    python: PYTHON_SINKS.map((sink) => ({ sink, pattern: compilePatterns(sink.calls) })),
    javascript: JAVASCRIPT_SINKS.map((sink) => ({ sink, pattern: compilePatterns(sink.calls) })),
    guards: GUARDS.map((guard) => ({ kinds: guard.kinds, pattern: compilePatterns(guard.calls) })),
    approvals: compilePatterns(APPROVAL_CALLS),
  };
  return compiled;
}

function sinksFor(file: ProjectFile): CompiledSink[] {
  return file.language === "python" ? catalog().python : catalog().javascript;
}

/** The sink a canonical call name matches in a file of the given language. */
export function sinkOf(name: string, language: Language): Sink | undefined {
  const sinks = language === "python" ? catalog().python : catalog().javascript;
  return sinks.find(({ pattern }) => pattern.test(name))?.sink;
}

/**
 * Fills in what tools, entry points and agents can do, by following their handlers
 * through project functions (across files) down to calls with an outside effect, and
 * where the output of model calls and agent runs is used.
 */
export function analyzeCapabilities(project: Project, inventory: Inventory): void {
  new CapabilityAnalyzer(project, inventory).run();
}

class CapabilityAnalyzer {
  readonly #project: Project;
  readonly #inventory: Inventory;
  readonly #llmCalls = new Map<string, LlmCall>();
  readonly #agentRuns = new Map<string, { agent: Agent; inputs: DynamicPart[] }>();
  readonly #prompts: Map<string, Prompt>;
  readonly #memo = new Map<string, Capability[]>();
  readonly #active = new Set<string>();
  readonly #approvals = new Map<string, string | null>();
  readonly #scopes = new Map<string, Map<string, Set<string>>>();
  readonly #callsAt = new Map<string, Map<string, CallFact[]>>();

  constructor(project: Project, inventory: Inventory) {
    this.#project = project;
    this.#inventory = inventory;
    this.#prompts = new Map(inventory.prompts.map((prompt) => [prompt.id, prompt]));
    for (const call of inventory.llmCalls) this.#llmCalls.set(key(call.location), call);
    for (const agent of inventory.agents) {
      for (const run of agent.invocations)
        this.#agentRuns.set(key(run.location), { agent, inputs: run.inputs });
    }
  }

  run(): void {
    for (const call of this.#inventory.llmCalls) call.systemInputs = this.systemInputs(call);
    for (const tool of this.#inventory.tools) {
      tool.capabilities = this.toolCapabilities(tool);
      const approval = this.toolApproval(tool);
      if (approval !== null) tool.approval = approval;
    }
    for (const entry of this.#inventory.entryPoints) {
      entry.reaches =
        entry.handler === null
          ? []
          : this.effects(entry.handlerPath ?? entry.location.path, entry.handler, 0);
    }
    const tools = new Map(this.#inventory.tools.map((tool) => [tool.id, tool]));
    for (const agent of this.#inventory.agents) {
      agent.capabilities = this.agentCapabilities(agent, tools);
      const approval = this.agentApproval(agent);
      if (approval !== null) agent.approval = approval;
    }
    this.outputEffects();
  }

  /** The system prompt's dynamic parts and the values the call passes for its template variables. */
  systemInputs(llm: LlmCall): DynamicPart[] {
    const prompts = llm.prompts
      .map((id) => this.#prompts.get(id))
      .filter((prompt): prompt is Prompt => prompt?.role === "system");
    const parts = prompts.flatMap((prompt) => prompt.dynamic);
    const variables = new Set(prompts.flatMap((prompt) => prompt.variables));
    const site = this.callAt(llm.location, llm.target);
    if (site !== undefined) {
      for (const variable of variables) {
        for (const value of select(site.call.arguments, site.file.facts, variable))
          parts.push(...inputsOf(value, site.file.facts, site.call.scope));
      }
    }
    return uniqueParts(parts);
  }

  toolCapabilities(tool: Tool): Capability[] {
    if (tool.via === "builtin") {
      const known = BUILTIN_TOOL_CAPABILITIES.find((entry) => entry.name.test(tool.name));
      if (known === undefined) return [];
      const capability: Capability = {
        kind: known.kind,
        target: tool.name,
        location: tool.location,
        via: [],
        inputs: [],
      };
      // `ShellTool(environment={"type": "container_auto"})` runs in a container at the provider.
      const site = this.callAt(tool.location);
      const environment =
        site === undefined
          ? null
          : literalString(
              select(site.call.arguments, site.file.facts, "environment.type")[0],
              site.file.facts,
            );
      const hosted = known.hosted === true || /^container/.test(environment ?? "");
      if (hosted) capability.hosted = true;
      if (known.kind === "process") capability.command = "shell";
      if (known.kind === "code" || known.kind === "process")
        capability.sandbox = hosted ? "remote" : "none";
      return [capability];
    }
    if (tool.via === "agent" && tool.agent !== undefined) {
      return [{ kind: "agent", target: tool.agent, location: tool.location, via: [], inputs: [] }];
    }
    if (tool.handler === null) return [];
    return this.effects(tool.handlerPath ?? tool.location.path, tool.handler, 0);
  }

  /** An approval option on the tool's declaration, or a call in its handler that asks a person. */
  toolApproval(tool: Tool): string | null {
    const file = this.#project.files.get(tool.location.path);
    if (file !== undefined) {
      const options: (Argument[] | null)[] = [];
      for (const call of this.callsAt(file, tool.location)) options.push(call.arguments);
      const definition = file.facts.definitions.find((candidate) =>
        sameStart(candidate.span, tool.location),
      );
      for (const decorator of definition?.decorators ?? []) options.push(decorator.arguments);
      for (const args of options) {
        const option = approvalOption(args, file.facts);
        if (option !== null) return option;
      }
    }
    if (tool.via === "builtin") return this.approvalInArguments(tool.location);
    if (tool.handler === null) return null;
    return this.approvalIn(tool.handlerPath ?? tool.location.path, tool.handler, 0);
  }

  /**
   * A built-in tool given a project object that asks a person before acting
   * (`ApplyPatchTool(editor=WorkspaceEditor(...))` whose methods prompt for approval).
   */
  approvalInArguments(location: Location): string | null {
    const site = this.callAt(location);
    if (site === undefined) return null;
    const { file, call } = site;
    for (const arg of call.arguments) {
      for (const index of provenanceOf(arg.value, file.facts, call.scope).calls) {
        const ref = file.facts.calls[index]?.ref;
        if (ref?.kind !== "local" || (ref.path !== "" && ref.path !== "()")) continue;
        const path = ref.file ?? file.path;
        const methods = (this.#project.files.get(path)?.facts.definitions ?? []).filter(
          (definition) => definition.parent === ref.definition,
        );
        for (const method of methods) {
          const found = this.approvalIn(path, method.id, 0);
          if (found !== null) return found;
        }
      }
    }
    return null;
  }

  /** Approval for a whole agent: graph interrupts, approval middleware, a human in the loop, or a node that asks. */
  agentApproval(agent: Agent): string | null {
    const site = this.callAt(agent.location, agent.target);
    if (site !== undefined) {
      const { call } = site;
      const facts = site.file.facts;
      for (const option of INTERRUPT_OPTIONS) {
        if (isEnabled(select(call.arguments, facts, option)[0], facts)) return option;
      }
      if (literalString(select(call.arguments, facts, "human_input_mode")[0], facts) === "ALWAYS")
        return 'human_input_mode="ALWAYS"';
      for (const value of select(call.arguments, facts, "middleware[*]")) {
        const target = deref(value, facts);
        const name = target.kind === "call" ? facts.calls[target.call]?.ref?.name : undefined;
        if (name !== undefined && /HumanInTheLoopMiddleware$/i.test(name)) return shortName(name);
      }
      // `builder.compile(interrupt_before=[...])` on a graph built in the same file.
      for (const candidate of facts.calls) {
        if (!/\.compile$/.test(candidate.callee)) continue;
        const provenance = provenanceOf(
          { kind: "call", call: facts.calls.indexOf(candidate) },
          facts,
          candidate.scope,
        );
        if (!provenance.calls.has(facts.calls.indexOf(call))) continue;
        for (const option of INTERRUPT_OPTIONS) {
          if (isEnabled(select(candidate.arguments, facts, option)[0], facts)) return option;
        }
      }
      const option = approvalOption(call.arguments, facts);
      if (option !== null) return option;
    }
    for (const node of agent.nodes) {
      if (node.handler === null) continue;
      const found = this.approvalIn(node.handlerPath ?? agent.location.path, node.handler, 0);
      if (found !== null) return found;
    }
    return null;
  }

  agentCapabilities(agent: Agent, tools: Map<string, Tool>): Capability[] {
    const capabilities: Capability[] = [];
    for (const id of agent.tools) {
      for (const capability of tools.get(id)?.capabilities ?? [])
        capabilities.push({ ...capability, tool: id });
    }
    for (const id of agent.mcpClients) {
      const client = this.#inventory.mcpClients.find((candidate) => candidate.id === id);
      if (client === undefined) continue;
      capabilities.push({
        kind: "mcp",
        target: client.command ?? client.url ?? client.target,
        location: client.location,
        via: [],
        inputs: [],
      });
    }
    for (const id of agent.delegates) {
      capabilities.push({
        kind: "agent",
        target: id,
        location: agent.location,
        via: [],
        inputs: [],
      });
    }
    const code = this.codeExecution(agent);
    if (code !== null) capabilities.push(code);
    return unique(capabilities);
  }

  /** Agents that execute model-written code themselves, and where that code runs. */
  codeExecution(agent: Agent): Capability | null {
    const site = this.callAt(agent.location, agent.target);
    if (site === undefined) return null;
    const { call } = site;
    const facts = site.file.facts;
    const literal = (path: string) => {
      const [value] = select(call.arguments, facts, path);
      if (value === undefined) return null;
      const target = deref(value, facts);
      return target.kind === "literal" ? target.text : literalString(value, facts);
    };
    const callName = (path: string) => {
      const [value] = select(call.arguments, facts, path);
      const resolved = value === undefined ? undefined : deref(value, facts);
      return resolved?.kind === "call" ? facts.calls[resolved.call]?.ref?.name : undefined;
    };
    let target: string | null = null;
    let sandbox: Capability["sandbox"];
    if (/(?:^|\.)CodeAgent$/.test(agent.target) && agent.framework === "smolagents") {
      const executor = literal("executor_type") ?? "local";
      target = `${agent.target}(executor_type=${executor})`;
      sandbox = executorSandbox(executor);
    } else if (agent.framework === "crewai" && literal("allow_code_execution") === "True") {
      const mode = literal("code_execution_mode") ?? "safe";
      target = `${agent.target}(code_execution_mode=${mode})`;
      sandbox = mode === "unsafe" ? "none" : "container";
    } else if (/CodeExecutorAgent$/.test(agent.target)) {
      const name = callName("code_executor|#1");
      target = `${agent.target}(${name ?? "code executor"})`;
      sandbox = name === undefined ? undefined : executorSandbox(name);
    } else if (
      /(?:UserProxyAgent|ConversableAgent)$/.test(agent.target) &&
      agent.framework === "autogen"
    ) {
      const config = literal("code_execution_config");
      const present = select(call.arguments, facts, "code_execution_config").length > 0;
      if (present && config !== "False") {
        target = `${agent.target}(code_execution_config)`;
        const executor = callName("code_execution_config.executor");
        const docker = literal("code_execution_config.use_docker");
        if (executor !== undefined) sandbox = executorSandbox(executor);
        else if (docker === "False") sandbox = "none";
        else if (docker !== null) sandbox = "container";
      }
    }
    if (target === null) return null;
    const capability: Capability = {
      kind: "code",
      target,
      location: agent.location,
      via: [],
      inputs: [],
    };
    if (sandbox !== undefined) capability.sandbox = sandbox;
    return capability;
  }

  /** Effects of a project function (or a file's module code) and of the project functions it calls. */
  effects(path: string, definition: string, depth: number): Capability[] {
    const memoKey = `${path}|${definition}`;
    const cached = this.#memo.get(memoKey);
    if (cached !== undefined) return cached;
    const file = this.#project.files.get(path);
    if (file === undefined || this.#active.has(memoKey) || depth > MAX_DEPTH) return [];
    this.#active.add(memoKey);
    const scopes = this.scopesOf(file, definition);
    const found: Capability[] = [];
    const guards: Guard[] = [];
    for (const call of file.facts.calls) {
      if (!scopes.has(call.scope ?? MODULE)) continue;
      found.push(...this.callEffects(file, call, depth));
      const guard = this.guardOf(file, call);
      if (guard !== null) guards.push(guard);
    }
    found.push(...this.environmentReads(file, scopes));
    this.#active.delete(memoKey);
    const result = unique(found).map((effect) => withGuards(effect, guards));
    this.#memo.set(memoKey, result);
    return result;
  }

  callEffects(file: ProjectFile, call: CallFact, depth: number): Capability[] {
    const location = locate(file.path, call.span);
    const effects: Capability[] = [];
    const llm = this.#llmCalls.get(key(location));
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
    const run = this.#agentRuns.get(key(location));
    if (run !== undefined) {
      effects.push({ kind: "agent", target: run.agent.id, location, via: [], inputs: run.inputs });
    }
    const name = call.ref?.name;
    if (name !== undefined && call.ref?.kind !== "local") {
      const match = sinksFor(file).find(({ pattern }) => pattern.test(name));
      if (match !== undefined) effects.push(this.sinkEffect(file, call, match.sink, location));
    }
    const target = this.calledFunction(file, call);
    if (target !== null) {
      const bindings = this.bindArguments(file, call, target);
      for (const effect of this.effects(target.path, target.definition, depth + 1)) {
        const bound: Capability = {
          ...effect,
          via: [location, ...effect.via],
          inputs: rebind(effect.inputs, bindings, "inputs"),
        };
        if (effect.systemInputs !== undefined)
          bound.systemInputs = rebind(effect.systemInputs, bindings, "inputs");
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
    const definition = callee?.facts.definitions.find(
      (candidate) => candidate.id === target.definition,
    );
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
    const kinds = catalog()
      .guards.filter(({ pattern }) => pattern.test(name))
      .flatMap((guard) => guard.kinds);
    if (kinds.length === 0) return null;
    const params = new Set<string>();
    for (const arg of call.arguments) {
      for (const param of provenanceOf(arg.value, file.facts, call.scope).params) params.add(param);
    }
    return { name, kinds, params };
  }

  /** The first call that asks a person, in a function or the project functions it calls. */
  approvalIn(path: string, definition: string, depth: number): string | null {
    const memoKey = `${path}|${definition}`;
    const cached = this.#approvals.get(memoKey);
    if (cached !== undefined) return cached;
    const file = this.#project.files.get(path);
    if (file === undefined || depth > MAX_DEPTH) return null;
    this.#approvals.set(memoKey, null);
    const scopes = this.scopesOf(file, definition);
    let found: string | null = null;
    for (const call of file.facts.calls) {
      if (!scopes.has(call.scope ?? MODULE)) continue;
      const name = call.ref?.name;
      if (name !== undefined && call.ref?.kind !== "local" && catalog().approvals.test(name)) {
        found = name;
        break;
      }
      const target = this.calledFunction(file, call);
      if (target !== null) {
        found = this.approvalIn(target.path, target.definition, depth + 1);
        if (found !== null) break;
      }
    }
    this.#approvals.set(memoKey, found);
    return found;
  }

  /**
   * Effects whose input is model output: for every function that calls a model or runs
   * an agent, the effects it reaches (through project functions too) with an input
   * computed from that call's result.
   */
  outputEffects(): void {
    const sites = new Map<
      string,
      {
        path: string;
        scope: string;
        llms: LlmCall[];
        runs: { agent: Agent; name: string; location: Location }[];
      }
    >();
    const site = (path: string, scope: string | null) => {
      const id = `${path}|${scope ?? MODULE}`;
      let entry = sites.get(id);
      if (entry === undefined) {
        entry = { path, scope: scope ?? MODULE, llms: [], runs: [] };
        sites.set(id, entry);
      }
      return entry;
    };
    for (const llm of this.#inventory.llmCalls) site(llm.location.path, llm.scope).llms.push(llm);
    for (const agent of this.#inventory.agents) {
      for (const run of agent.invocations) {
        const call = this.callAt(run.location)?.call;
        if (call?.ref?.name !== undefined)
          site(run.location.path, call.scope).runs.push({
            agent,
            name: call.ref.name,
            location: run.location,
          });
      }
    }
    for (const { path, scope, llms, runs } of sites.values()) {
      for (const effect of this.effects(path, scope, 0)) {
        if (!OUTPUT_SINKS.has(effect.kind)) continue;
        // `name@line:column` of every call the effect's inputs come from, in this function's file.
        const from = new Set(
          [...effect.inputs, ...(effect.host ?? [])].flatMap((part) =>
            (part.calls ?? []).map((name, index) => `${name}@${part.callSites?.[index]}`),
          ),
        );
        if (from.size === 0) continue;
        const at = (name: string, location: Location) =>
          from.has(`${name}@${location.line}:${location.column}`);
        for (const llm of llms) {
          if (at(llm.target, llm.location) && !llm.outputEffects.some((item) => same(item, effect)))
            llm.outputEffects.push(effect);
        }
        for (const { agent, name, location } of runs) {
          if (at(name, location) && !agent.outputEffects.some((item) => same(item, effect)))
            agent.outputEffects.push(effect);
        }
      }
    }
  }

  /** The project function a call runs: a function, a method, or a class constructor. */
  calledFunction(file: ProjectFile, call: CallFact): { path: string; definition: string } | null {
    const ref = call.ref;
    if (ref?.kind !== "local") return null;
    const path = ref.file ?? file.path;
    const definitions = this.#project.files.get(path)?.facts.definitions ?? [];
    const has = (id: string) => definitions.some((definition) => definition.id === id);
    const base = definitions.find((definition) => definition.id === ref.definition);
    if (base === undefined) return null;
    const member = /^(?:\(\))?\.([\w$#]+)$/.exec(ref.path)?.[1];
    if (member !== undefined) {
      const id = `${ref.definition}.${member}`;
      return has(id) ? { path, definition: id } : null;
    }
    if (ref.path !== "" && ref.path !== "()") return null;
    if (base.kind !== "class") return ref.path === "" ? { path, definition: base.id } : null;
    for (const initializer of ["__init__", "constructor"]) {
      if (has(`${base.id}.${initializer}`))
        return { path, definition: `${base.id}.${initializer}` };
    }
    return null;
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
      if (!scopes.has(call.scope ?? MODULE)) continue;
      for (const arg of call.arguments) visit(arg.value, call.span);
    }
    for (const assignment of file.facts.assignments) {
      if (scopes.has(assignment.scope ?? MODULE)) visit(assignment.value, assignment.span);
    }
    for (const definition of file.facts.definitions) {
      if (!scopes.has(definition.id)) continue;
      for (const value of definition.returns ?? []) visit(value, definition.span);
    }
    return found;
  }

  /** A definition and every function nested in it (callbacks, inline arrow functions). */
  scopesOf(file: ProjectFile, definition: string): Set<string> {
    if (definition === MODULE) return new Set([MODULE]);
    let byFile = this.#scopes.get(file.path);
    if (byFile === undefined) {
      byFile = new Map();
      const children = new Map<string, string[]>();
      for (const fact of file.facts.definitions) {
        if (fact.parent === null) continue;
        const list = children.get(fact.parent) ?? [];
        list.push(fact.id);
        children.set(fact.parent, list);
      }
      for (const fact of file.facts.definitions) {
        const scopes = new Set<string>();
        const pending = [fact.id];
        while (pending.length > 0) {
          const id = pending.pop() as string;
          if (scopes.has(id)) continue;
          scopes.add(id);
          // Methods of a nested class run on their own; plain nested functions are part of the body.
          for (const child of children.get(id) ?? []) pending.push(child);
        }
        byFile.set(fact.id, scopes);
      }
      this.#scopes.set(file.path, byFile);
    }
    return byFile.get(definition) ?? new Set([definition]);
  }

  /** Calls that start at a location (the calls of a chain share their start). */
  callsAt(file: ProjectFile, location: Location): CallFact[] {
    let index = this.#callsAt.get(file.path);
    if (index === undefined) {
      index = new Map();
      for (const call of file.facts.calls) {
        const at = `${call.span.line}:${call.span.column}`;
        const list = index.get(at) ?? [];
        list.push(call);
        index.set(at, list);
      }
      this.#callsAt.set(file.path, index);
    }
    return index.get(`${location.line}:${location.column}`) ?? [];
  }

  /** The call an inventory item was found at, preferring the one with the item's target. */
  callAt(location: Location, target?: string): { file: ProjectFile; call: CallFact } | undefined {
    const file = this.#project.files.get(location.path);
    if (file === undefined) return undefined;
    const calls = this.callsAt(file, location).filter(
      (call) =>
        call.span.endLine === location.endLine && call.span.endColumn === location.endColumn,
    );
    const call = calls.find((candidate) => candidate.ref?.name === target) ?? calls[0];
    return call === undefined ? undefined : { file, call };
  }
}

/** An approval option set to anything but false or never. */
function approvalOption(args: Argument[] | null, facts: FileFacts): string | null {
  for (const option of APPROVAL_OPTIONS) {
    const [value] = select(args, facts, option);
    if (isEnabled(value, facts)) return option;
  }
  return null;
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

/** Where a code executor runs code, from its name or `executor_type`. */
function executorSandbox(name: string): Capability["sandbox"] | undefined {
  if (/local|jupyter/i.test(name)) return "none";
  if (/docker|wasm|container/i.test(name)) return "container";
  if (/e2b|modal|blaxel|azure|aca|session/i.test(name)) return "remote";
  return undefined;
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

/** What a caller passes for a parameter: its non-constant parts, and those that decide a URL's host. */
interface Bound {
  inputs: DynamicPart[];
  host: DynamicPart[];
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
  return facts.calls
    .filter(
      (candidate) =>
        candidate !== call &&
        candidate.span.line === call.span.line &&
        candidate.span.column === call.span.column,
    )
    .sort((a, b) => a.span.endLine - b.span.endLine || a.span.endColumn - b.span.endColumn)[0];
}

/** Non-constant parts of an effect's input; for a command list, of each item. */
function inputsOf(value: Value, facts: FileFacts, scope: string | null): DynamicPart[] {
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

function sameStart(span: Span, location: Location): boolean {
  return span.line === location.line && span.column === location.column;
}

function shortName(target: string): string {
  return /([\w$]+)(?:\(\))?$/.exec(target)?.[1] ?? target;
}

function locate(path: string, span: Span): Location {
  return { path, ...span };
}

function key(location: Location): string {
  return `${location.path}:${location.line}:${location.column}`;
}

function same(a: Capability, b: Capability): boolean {
  return a.kind === b.kind && a.target === b.target && key(a.location) === key(b.location);
}

function unique(capabilities: Capability[]): Capability[] {
  const seen = new Set<string>();
  return capabilities.filter((capability) => {
    const id = `${capability.kind}|${capability.target}|${key(capability.location)}|${capability.tool ?? ""}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function uniqueParts(parts: DynamicPart[]): DynamicPart[] {
  const seen = new Set<string>();
  return parts.filter((part) => {
    const id = `${part.source}:${part.text}:${part.from?.join(",") ?? ""}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
