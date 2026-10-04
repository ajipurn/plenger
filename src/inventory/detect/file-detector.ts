import type { CallFact, FileFacts, Value } from "../../facts/model.ts";
import { select } from "../../facts/query.ts";
import type { Language } from "../../source/languages.ts";
import type { AgentRule, DetectorRule } from "../detectors.ts";
import { FRAMEWORKS, frameworkOfModule, unsupportedModule } from "../frameworks.ts";
import { type Agent, emptyInventory, type Inventory, type Prompt, type Tool } from "../model.ts";
import { AGENT_INVOCATION, type Compiled, inPhase, type Phase, rulesFor } from "./compile.ts";
import {
  agent,
  dataStore,
  mcpClient,
  mcpServer,
  model,
  promptCall,
  toolBuiltin,
  toolClass,
  toolDecorator,
  toolFactory,
} from "./constructors.ts";
import { FileScope } from "./file-scope.ts";
import type { ProjectDetector } from "./index.ts";
import { InstanceRegistry } from "./instances.ts";
import { mcpMemberCall, mcpMemberDecorator, mcpTransport } from "./mcp.ts";
import { PromptCollector } from "./prompts.ts";
import { Relations } from "./relations.ts";
import { routeCall, routeDecorator, routeFiles } from "./routes.ts";
import { ToolRegistry } from "./tools.ts";

/**
 * Detects the components of one file. The rule handlers live in the sibling modules
 * and work through the registries here; the phases are run by `ProjectDetector`.
 */
export class FileDetector {
  readonly inventory = emptyInventory();
  readonly scope: FileScope;
  readonly project: ProjectDetector;
  readonly instances: InstanceRegistry;
  readonly tools: ToolRegistry;
  readonly prompts: PromptCollector;
  readonly #relations: Relations;
  readonly #rules: Compiled[];
  /** Agents whose delegates and MCP clients resolve once every agent and client exists. */
  readonly agentLinks: { agent: Agent; rule: AgentRule; call: CallFact }[] = [];
  /** Decorated tools and prompts to attach to the agent instance they were declared on. */
  readonly receiverLinks: { receiver: number | undefined; tool?: Tool; prompt?: Prompt }[] = [];

  constructor(path: string, language: Language, facts: FileFacts, project: ProjectDetector) {
    this.scope = new FileScope(path, language, facts);
    this.project = project;
    this.instances = new InstanceRegistry(this.scope, project);
    this.tools = new ToolRegistry(this.scope, this.inventory, project, this.instances);
    this.prompts = new PromptCollector(this.scope, this.inventory);
    this.#relations = new Relations(this);
    this.#rules = rulesFor(language);
  }

  get facts(): FileFacts {
    return this.scope.facts;
  }

  // Phases, run by ProjectDetector over every file in turn.

  constructTools(): void {
    this.matchDefinitions(true);
    for (const [index, call] of this.facts.calls.entries())
      this.matchCall(call, index, "construct_tools");
  }

  constructAgents(): void {
    for (const [index, call] of this.facts.calls.entries()) {
      this.matchCall(call, index, "construct_agents");
    }
  }

  linkAgents(): void {
    this.#relations.linkAgents();
  }

  relate(): void {
    // Tool bindings first, so graph nodes and LLM calls can find their results.
    for (const [index, call] of this.facts.calls.entries()) {
      this.matchCall(call, index, "bind_tools");
    }
    for (const [index, call] of this.facts.calls.entries()) this.matchCall(call, index, "relate");
    this.matchDefinitions(false);
  }

  finish(): void {
    routeFiles(this);
    this.componentFrameworks();
  }

  /** Imports of the project's own modules are not framework calls, whatever their name. */
  isLocal(ref: CallFact["ref"]): boolean {
    return ref?.kind === "import" && this.isLocalModule(ref.module);
  }

  isLocalModule(module: string): boolean {
    if (this.scope.language !== "python") return false;
    return (
      module.startsWith(".") || this.project.project.localModules.has(module.split(".")[0] ?? "")
    );
  }

  whereHolds(rule: DetectorRule, args: CallFact["arguments"] | null): boolean {
    if (rule.where === undefined) return true;
    const value = this.scope.literal(select(args, this.facts, rule.where.path));
    return value !== null && rule.where.equals.includes(value);
  }

  /** A model name, resolved through the model objects this file constructs. */
  modelName(values: Value[]): string | null {
    return this.scope.modelName(values, (callIndex) => this.instances.modelOfCall(callIndex));
  }

  // Matching

  matchDefinitions(constructors: boolean): void {
    for (const definition of this.facts.definitions) {
      for (const decorator of definition.decorators) {
        const name = decorator.ref?.name;
        if (name === undefined || this.isLocal(decorator.ref)) continue;
        for (const { rule, decorators } of this.#rules) {
          if (decorators === null || !decorators.test(name)) continue;
          if (constructors && rule.kind === "tool_decorator")
            toolDecorator(this, rule, definition, decorator);
          if (constructors && rule.kind === "prompt_decorator") {
            const prompt = this.prompts.functionPrompt(definition);
            this.receiverLinks.push({ receiver: decorator.receiver, prompt });
          }
          if (!constructors && rule.kind === "mcp_member")
            mcpMemberDecorator(this, rule, definition, decorator);
          if (!constructors && rule.kind === "route")
            routeDecorator(this, rule, definition, decorator);
        }
      }
      if (!constructors) continue;
      for (const base of definition.bases) {
        const name = base.kind === "name" ? base.ref?.name : undefined;
        if (name === undefined || (base.kind === "name" && this.isLocal(base.ref))) continue;
        for (const { rule, bases } of this.#rules) {
          if (bases?.test(name) && rule.kind === "tool_class") toolClass(this, rule, definition);
        }
      }
    }
  }

  matchCall(call: CallFact, index: number, phase: Phase): void {
    const name = call.ref?.name;
    if (name === undefined || this.isLocal(call.ref)) return;
    for (const { rule, calls, invoke } of this.#rules) {
      if (
        rule.kind === "agent" &&
        invoke !== null &&
        inPhase(phase, AGENT_INVOCATION) &&
        invoke.test(name)
      ) {
        this.#relations.invocation(rule, call, index);
      }
      if (calls === null || !inPhase(phase, rule.kind) || !calls.test(name)) continue;
      if (!this.whereHolds(rule, call.arguments)) continue;
      switch (rule.kind) {
        case "agent_run":
          this.#relations.agentRun(rule, call, index);
          break;
        case "tool_builtin":
          toolBuiltin(this, rule, call, index);
          break;
        case "model":
          model(this, rule, call, index);
          break;
        case "agent":
          agent(this, rule, call, index);
          break;
        case "llm_call":
          this.#relations.llmCall(rule, call);
          break;
        case "tool_factory":
          toolFactory(this, rule, call, index);
          break;
        case "tool_binding":
          this.#relations.toolBinding(rule, call, index);
          break;
        case "graph_node":
          this.#relations.graphNode(rule, call);
          break;
        case "mcp_server":
          mcpServer(this, rule.framework, call, index, rule.name);
          break;
        case "mcp_member":
          mcpMemberCall(this, rule, call);
          break;
        case "mcp_transport":
          mcpTransport(this, rule, call);
          break;
        case "mcp_client":
          mcpClient(this, rule, call, index);
          break;
        case "route":
          routeCall(this, rule, call);
          break;
        case "data_store":
          dataStore(this, rule, call, name);
          break;
        case "prompt":
          promptCall(this, rule, call);
          break;
        default:
          break;
      }
    }
    // Agents run through a variable: `agent.invoke(...)` on an instance plenger built.
    if (inPhase(phase, AGENT_INVOCATION)) {
      const instance = this.instances.instanceOfCall(call);
      const method = /\.([\w$]+)$/.exec(name)?.[1];
      if (
        instance?.kind === "agent" &&
        method !== undefined &&
        instance.rule.invokeMethods?.includes(method)
      ) {
        this.#relations.addInvocation(instance.component, call, index, instance.rule.input);
      }
    }
  }

  // Frameworks

  frameworks(): void {
    const unrecognised = new Set<string>();
    for (const fact of this.facts.imports) {
      if (this.isLocalModule(fact.module)) continue;
      const framework = frameworkOfModule(fact.module, this.scope.language);
      if (framework !== undefined) this.addFramework(framework.id);
      const unsupported = unsupportedModule(fact.module, this.scope.language);
      if (unsupported !== undefined) unrecognised.add(unsupported.replace(/\/\*$/, ""));
    }
    for (const module of unrecognised)
      this.inventory.unrecognised.push({ module, files: [this.scope.path] });
  }

  /** Frameworks seen only through components (`boto3` calls to Bedrock). */
  componentFrameworks(): void {
    const inventory: Inventory = this.inventory;
    const used = [
      ...inventory.models,
      ...inventory.llmCalls,
      ...inventory.agents,
      ...inventory.tools,
      ...inventory.mcpServers,
      ...inventory.mcpClients,
      ...inventory.dataStores,
      ...inventory.entryPoints,
    ].map((component) => component.framework);
    for (const id of new Set(used)) this.addFramework(id);
  }

  addFramework(id: string): void {
    if (this.inventory.frameworks.some((framework) => framework.id === id)) return;
    const info = FRAMEWORKS.find((framework) => framework.id === id);
    this.inventory.frameworks.push({ id, name: info?.name ?? id, files: [this.scope.path] });
  }
}
