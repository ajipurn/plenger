import { deref, literalString, select } from "../facts/query.ts";
import type {
  Agent,
  Capability,
  DynamicPart,
  Inventory,
  LlmCall,
  Prompt,
  Tool,
  TraceGaps,
} from "../inventory/model.ts";
import { ProjectIndex } from "../project/index.ts";
import type { Project } from "../project/project.ts";
import { ApprovalFinder } from "./approvals.ts";
import { EffectTracer, inputsOf, unique, uniqueParts } from "./effects.ts";
import { callerParams, type PublicFunction, publicFunctions } from "./library.ts";
import { attachOutputEffects } from "./output.ts";
import { type Receiver, receivedEffects } from "./received.ts";
import { BUILTIN_TOOL_CAPABILITIES } from "./sinks.ts";

export interface AnalyzeOptions {
  /** Also trace the project's public functions and methods, for library checks. */
  library?: boolean;
}

/**
 * Fills in what tools, entry points and agents can do, by following their handlers
 * through project functions (across files) down to calls with an outside effect, and
 * where the output of model calls and agent runs is used. Returns the calls that receive
 * data over the network with the effects that use it, and, for a library scan, what each
 * public function and method reaches.
 */
export function analyzeCapabilities(
  project: Project,
  inventory: Inventory,
  options: AnalyzeOptions = {},
): { functions: PublicFunction[]; received: Receiver[] } {
  const analyzer = new CapabilityAnalyzer(project, inventory, options);
  analyzer.run();
  return {
    functions: options.library === true ? analyzer.publicFunctions(project) : [],
    received: analyzer.received(project),
  };
}

class CapabilityAnalyzer {
  readonly #inventory: Inventory;
  readonly #index: ProjectIndex;
  readonly #effects: EffectTracer;
  readonly #approvals: ApprovalFinder;
  readonly #prompts: Map<string, Prompt>;

  constructor(project: Project, inventory: Inventory, options: AnalyzeOptions) {
    this.#inventory = inventory;
    this.#index = new ProjectIndex(project);
    this.#effects = new EffectTracer(project, this.#index, inventory, {
      library: options.library === true,
    });
    this.#approvals = new ApprovalFinder(project, this.#index);
    this.#prompts = new Map(inventory.prompts.map((prompt) => [prompt.id, prompt]));
  }

  run(): void {
    for (const call of this.#inventory.llmCalls) call.systemInputs = this.systemInputs(call);
    for (const tool of this.#inventory.tools) {
      tool.capabilities = this.toolCapabilities(tool);
      const trace = this.traceGaps(tool.handlerPath ?? tool.location.path, tool.handler);
      if (trace !== null) tool.trace = trace;
      const approval = this.#approvals.toolApproval(tool);
      if (approval !== null) tool.approval = approval;
    }
    for (const entry of this.#inventory.entryPoints) {
      const path = entry.handlerPath ?? entry.location.path;
      entry.reaches = entry.handler === null ? [] : this.#effects.effects(path, entry.handler, 0);
      const trace = this.traceGaps(path, entry.handler);
      if (trace !== null) entry.trace = trace;
    }
    const tools = new Map(this.#inventory.tools.map((tool) => [tool.id, tool]));
    for (const agent of this.#inventory.agents) {
      agent.capabilities = this.agentCapabilities(agent, tools);
      const approval = this.#approvals.agentApproval(agent);
      if (approval !== null) agent.approval = approval;
    }
    attachOutputEffects(this.#inventory, this.#effects, this.#index);
  }

  /** Calls that receive data over the network, with the effects that use it. */
  received(project: Project): Receiver[] {
    return receivedEffects(project, this.#index, this.#effects);
  }

  /** What each public function and method reaches, traced like a route handler. */
  publicFunctions(project: Project): PublicFunction[] {
    return publicFunctions(project).map(({ file, definition }) => {
      const traced: PublicFunction = {
        definition: definition.id,
        path: file.path,
        params: callerParams(definition),
        location: { path: file.path, ...definition.span },
        reaches: this.#effects.effects(file.path, definition.id, 0),
      };
      const trace = this.traceGaps(file.path, definition.id);
      if (trace !== null) traced.trace = trace;
      return traced;
    });
  }

  /** Calls a traced handler could not follow; built-in and agent tools have no handler trace. */
  traceGaps(path: string, handler: string | null): TraceGaps | null {
    return handler === null ? null : this.#effects.gaps(path, handler);
  }

  /** The system prompt's dynamic parts and the values the call passes for its template variables. */
  systemInputs(llm: LlmCall): DynamicPart[] {
    const prompts = llm.prompts
      .map((id) => this.#prompts.get(id))
      .filter((prompt): prompt is Prompt => prompt?.role === "system");
    const parts = prompts.flatMap((prompt) => prompt.dynamic);
    const variables = new Set(prompts.flatMap((prompt) => prompt.variables));
    const site = this.#index.callAt(llm.location, llm.target);
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
      const site = this.#index.callAt(tool.location);
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
    return this.#effects.effects(tool.handlerPath ?? tool.location.path, tool.handler, 0);
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
    const site = this.#index.callAt(agent.location, agent.target);
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
}

/** Where a code executor runs code, from its name or `executor_type`. */
function executorSandbox(name: string): Capability["sandbox"] | undefined {
  if (/local|jupyter/i.test(name)) return "none";
  if (/docker|wasm|container/i.test(name)) return "container";
  if (/e2b|modal|blaxel|azure|aca|session/i.test(name)) return "remote";
  return undefined;
}
