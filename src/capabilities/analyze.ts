import type { CallFact, FileFacts, Span, Value } from "../facts/model.ts";
import type {
  Agent,
  Capability,
  DynamicPart,
  Inventory,
  LlmCall,
  Location,
  Tool,
} from "../inventory/model.ts";
import { compilePatterns } from "../inventory/pattern.ts";
import { deref, dynamicPart, literalString, select, summarizeText } from "../inventory/values.ts";
import type { Project, ProjectFile } from "../project/project.ts";
import { BUILTIN_TOOL_CAPABILITIES, JAVASCRIPT_SINKS, PYTHON_SINKS, type Sink } from "./sinks.ts";

/** How many project functions deep the analysis follows calls. */
const MAX_DEPTH = 6;
const ENVIRONMENT = /^(?:os\.environ|process\.env|import\.meta\.env)\.[\w$]+$/;

interface CompiledSink {
  sink: Sink;
  pattern: RegExp;
}

let compiledSinks: { python: CompiledSink[]; javascript: CompiledSink[] } | undefined;

function sinksFor(file: ProjectFile): CompiledSink[] {
  compiledSinks ??= {
    python: PYTHON_SINKS.map((sink) => ({ sink, pattern: compilePatterns(sink.calls) })),
    javascript: JAVASCRIPT_SINKS.map((sink) => ({ sink, pattern: compilePatterns(sink.calls) })),
  };
  return file.language === "python" ? compiledSinks.python : compiledSinks.javascript;
}

/**
 * Fills in what tools, entry points and agents can do, by following their handlers
 * through project functions (across files) down to calls with an outside effect.
 */
export function analyzeCapabilities(project: Project, inventory: Inventory): void {
  new CapabilityAnalyzer(project, inventory).run();
}

class CapabilityAnalyzer {
  readonly #project: Project;
  readonly #inventory: Inventory;
  readonly #llmCalls = new Map<string, LlmCall>();
  readonly #agentRuns = new Map<string, { agent: Agent; inputs: DynamicPart[] }>();
  readonly #memo = new Map<string, Capability[]>();
  readonly #active = new Set<string>();
  readonly #scopes = new Map<string, Map<string, Set<string>>>();

  constructor(project: Project, inventory: Inventory) {
    this.#project = project;
    this.#inventory = inventory;
    for (const call of inventory.llmCalls) this.#llmCalls.set(key(call.location), call);
    for (const agent of inventory.agents) {
      for (const run of agent.invocations)
        this.#agentRuns.set(key(run.location), { agent, inputs: run.inputs });
    }
  }

  run(): void {
    for (const tool of this.#inventory.tools) tool.capabilities = this.toolCapabilities(tool);
    for (const entry of this.#inventory.entryPoints) {
      entry.reaches =
        entry.handler === null
          ? []
          : this.effects(entry.handlerPath ?? entry.location.path, entry.handler, 0);
    }
    const tools = new Map(this.#inventory.tools.map((tool) => [tool.id, tool]));
    for (const agent of this.#inventory.agents)
      agent.capabilities = this.agentCapabilities(agent, tools);
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
      if (known.hosted) capability.hosted = true;
      return [capability];
    }
    if (tool.via === "agent" && tool.agent !== undefined) {
      return [{ kind: "agent", target: tool.agent, location: tool.location, via: [], inputs: [] }];
    }
    if (tool.handler === null) return [];
    return this.effects(tool.handlerPath ?? tool.location.path, tool.handler, 0);
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

  /** Agents that execute model-written code themselves. */
  codeExecution(agent: Agent): Capability | null {
    const file = this.#project.files.get(agent.location.path);
    const call = file?.facts.calls.find(
      (candidate) =>
        candidate.span.line === agent.location.line &&
        candidate.span.column === agent.location.column &&
        candidate.ref?.name === agent.target,
    );
    if (file === undefined || call === undefined) return null;
    const facts = file.facts;
    const literal = (path: string) => {
      const [value] = select(call.arguments, facts, path);
      if (value === undefined) return null;
      const target = deref(value, facts);
      return target.kind === "literal" ? target.text : literalString(value, facts);
    };
    let target: string | null = null;
    if (/(?:^|\.)CodeAgent$/.test(agent.target) && agent.framework === "smolagents") {
      target = `${agent.target}(executor_type=${literal("executor_type") ?? "local"})`;
    } else if (agent.framework === "crewai" && literal("allow_code_execution") === "True") {
      target = `${agent.target}(code_execution_mode=${literal("code_execution_mode") ?? "safe"})`;
    } else if (/CodeExecutorAgent$/.test(agent.target)) {
      const [executor] = select(call.arguments, facts, "code_executor|#1");
      const resolved = executor === undefined ? undefined : deref(executor, facts);
      const name = resolved?.kind === "call" ? facts.calls[resolved.call]?.ref?.name : undefined;
      target = `${agent.target}(${name ?? "code executor"})`;
    } else if (
      /(?:UserProxyAgent|ConversableAgent)$/.test(agent.target) &&
      agent.framework === "autogen"
    ) {
      const config = literal("code_execution_config");
      if (config !== null && config !== "False") target = `${agent.target}(code_execution_config)`;
      else if (
        select(call.arguments, facts, "code_execution_config").length > 0 &&
        config === null
      ) {
        target = `${agent.target}(code_execution_config)`;
      }
    }
    return target === null
      ? null
      : { kind: "code", target, location: agent.location, via: [], inputs: [] };
  }

  /** Effects of a project function and of the project functions it calls. */
  effects(path: string, definition: string, depth: number): Capability[] {
    const memoKey = `${path}|${definition}`;
    const cached = this.#memo.get(memoKey);
    if (cached !== undefined) return cached;
    const file = this.#project.files.get(path);
    if (file === undefined || this.#active.has(memoKey) || depth > MAX_DEPTH) return [];
    this.#active.add(memoKey);
    const scopes = this.scopesOf(file, definition);
    const found: Capability[] = [];
    for (const call of file.facts.calls) {
      if (call.scope !== null && scopes.has(call.scope))
        found.push(...this.callEffects(file, call, depth));
    }
    found.push(...this.environmentReads(file, scopes));
    this.#active.delete(memoKey);
    const result = unique(found);
    this.#memo.set(memoKey, result);
    return result;
  }

  callEffects(file: ProjectFile, call: CallFact, depth: number): Capability[] {
    const location = locate(file.path, call.span);
    const effects: Capability[] = [];
    const llm = this.#llmCalls.get(key(location));
    if (llm !== undefined)
      effects.push({ kind: "llm", target: llm.target, location, via: [], inputs: llm.inputs });
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
        effects.push({
          ...effect,
          via: [location, ...effect.via],
          inputs: rebind(effect.inputs, bindings),
        });
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
  ): Map<string, DynamicPart[]> {
    const callee = this.#project.files.get(target.path);
    const definition = callee?.facts.definitions.find(
      (candidate) => candidate.id === target.definition,
    );
    const bindings = new Map<string, DynamicPart[]>();
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
      if (name !== undefined) bindings.set(name, inputsOf(arg.value, file.facts));
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
    return {
      kind,
      target: call.ref?.name ?? call.callee,
      location,
      via: [],
      inputs: uniqueParts(values.flatMap((value) => inputsOf(value, facts))),
    };
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
      if (call.scope === null || !scopes.has(call.scope)) continue;
      for (const arg of call.arguments) visit(arg.value, call.span);
    }
    for (const assignment of file.facts.assignments) {
      if (assignment.scope !== null && scopes.has(assignment.scope))
        visit(assignment.value, assignment.span);
    }
    for (const definition of file.facts.definitions) {
      if (!scopes.has(definition.id)) continue;
      for (const value of definition.returns ?? []) visit(value, definition.span);
    }
    return found;
  }

  /** A definition and every function nested in it (callbacks, inline arrow functions). */
  scopesOf(file: ProjectFile, definition: string): Set<string> {
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
}

/** Replaces parameter inputs of the callee with what the caller passed for them. */
function rebind(inputs: DynamicPart[], bindings: Map<string, DynamicPart[]>): DynamicPart[] {
  if (bindings.size === 0) return inputs;
  return uniqueParts(
    inputs.flatMap((part) => {
      if (part.source !== "param") return [part];
      const root = /^[\w$]+/.exec(part.text)?.[0] ?? part.text;
      return bindings.get(root) ?? [part];
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
function inputsOf(value: Value, facts: FileFacts): DynamicPart[] {
  const summary = summarizeText(value, facts);
  if (summary !== null) return summary.dynamic;
  const target = deref(value, facts);
  if (target.kind === "list") return target.items.flatMap((item) => inputsOf(item, facts));
  if (target.kind === "name" || target.kind === "call") return [dynamicPart(target, facts)];
  return [];
}

function locate(path: string, span: Span): Location {
  return { path, ...span };
}

function key(location: Location): string {
  return `${location.path}:${location.line}:${location.column}`;
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
    const id = `${part.source}:${part.text}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
