import type {
  CallFact,
  Decorator,
  DefinitionFact,
  FileFacts,
  Span,
  Value,
} from "../facts/model.ts";
import type { Language } from "../languages.ts";
import { JAVASCRIPT_RULES } from "./catalog/javascript.ts";
import { PYTHON_RULES } from "./catalog/python.ts";
import { FRAMEWORKS, frameworkOfModule, unsupportedModule } from "./frameworks.ts";
import {
  type Agent,
  type DynamicPart,
  type EntryPoint,
  emptyInventory,
  type Inventory,
  type LlmCall,
  type Location,
  type McpClient,
  type McpServer,
  type Model,
  type Prompt,
  type Tool,
} from "./model.ts";
import { compilePatterns } from "./pattern.ts";
import type {
  AgentRule,
  AgentRunRule,
  GraphNodeRule,
  LlmCallRule,
  McpMemberRule,
  McpTransportRule,
  ModelRule,
  RouteRule,
  Rule,
  ToolBindingRule,
  ToolBuiltinRule,
  ToolClassRule,
  ToolDecoratorRule,
  ToolFactoryRule,
} from "./rules.ts";
import {
  credentialOf,
  deref,
  dynamicPart,
  environmentValue,
  literalString,
  select,
  summarizeText,
  urlString,
} from "./values.ts";

interface Compiled {
  rule: Rule;
  calls: RegExp | null;
  decorators: RegExp | null;
  bases: RegExp | null;
  invoke: RegExp | null;
}

const compiledRules = new Map<string, Compiled[]>();

function rulesFor(language: Language): Compiled[] {
  const family = language === "python" ? "python" : "javascript";
  let compiled = compiledRules.get(family);
  if (compiled === undefined) {
    compiled = (family === "python" ? PYTHON_RULES : JAVASCRIPT_RULES).map((rule) => ({
      rule,
      calls: "calls" in rule && rule.calls !== undefined ? compilePatterns(rule.calls) : null,
      decorators:
        "decorators" in rule && rule.decorators !== undefined
          ? compilePatterns(rule.decorators)
          : null,
      bases: "bases" in rule ? compilePatterns(rule.bases) : null,
      invoke:
        rule.kind === "agent" && rule.invoke !== undefined ? compilePatterns(rule.invoke) : null,
    }));
    compiledRules.set(family, compiled);
  }
  return compiled;
}

/** Rules that construct something other rules attach to; they run first. */
const CONSTRUCTORS = new Set([
  "model",
  "agent",
  "mcp_server",
  "tool_factory",
  "prompt",
  "data_store",
  "mcp_client",
  "tool_builtin",
]);

/** Methods whose result is the same model, agent or graph, so assigning it keeps the instance. */
const SAME_INSTANCE =
  /\.(?:compile|build|bind_tools|bindTools|with_structured_output|withStructuredOutput|with_config|withConfig|bind)\(\)$/;

type Instance =
  | { kind: "model"; component: Model; rule: ModelRule }
  | { kind: "agent"; component: Agent; rule: AgentRule }
  | { kind: "mcp_server"; component: McpServer }
  | { kind: "mcp_client"; component: McpClient };

/**
 * Detects the agent components in one file. `localModules` are the project's own
 * top-level Python modules: a local `agents` package is not the OpenAI Agents SDK.
 */
export function detectFile(
  path: string,
  language: Language,
  facts: FileFacts,
  localModules: ReadonlySet<string> = new Set(),
): Inventory {
  return new FileDetector(path, language, facts, localModules).run();
}

class FileDetector {
  readonly inventory = emptyInventory();
  readonly #path: string;
  readonly #language: Language;
  readonly #facts: FileFacts;
  readonly #rules: Compiled[];
  readonly #ids = new Set<string>();
  readonly #instanceByCall = new Map<number, Instance>();
  readonly #instanceByAssignment = new Map<number, Instance>();
  readonly #toolByHandler = new Map<string, Tool>();
  readonly #toolByCall = new Map<number, Tool>();
  readonly #toolByClass = new Map<string, Tool>();
  /** Tools whose name came from the variable or function, which a tools-object key may refine. */
  readonly #defaultNamed = new Set<Tool>();
  readonly #prompts = new Map<string, Prompt>();
  readonly #bindings = new Map<number, string[]>();
  readonly #assignmentOfCall = new Map<number, number>();
  readonly #invocations = new Map<Agent, Set<number>>();
  readonly #nodeOrder = new WeakMap<object, number>();
  readonly #localModules: ReadonlySet<string>;
  /** Agents whose delegates and MCP clients resolve once every agent and client exists. */
  readonly #agentLinks: { agent: Agent; rule: AgentRule; call: CallFact }[] = [];
  /** Decorated tools and prompts to attach to the agent instance they were declared on. */
  readonly #receiverLinks: { receiver: number | undefined; tool?: Tool; prompt?: Prompt }[] = [];

  constructor(
    path: string,
    language: Language,
    facts: FileFacts,
    localModules: ReadonlySet<string>,
  ) {
    this.#path = path;
    this.#language = language;
    this.#facts = facts;
    this.#localModules = localModules;
    this.#rules = rulesFor(language);
    facts.assignments.forEach((assignment, index) => {
      if (assignment.value.kind === "call" && assignment.member === undefined) {
        this.#assignmentOfCall.set(assignment.value.call, index);
      }
    });
  }

  run(): Inventory {
    this.frameworks();
    this.forEachMatch(true);
    this.linkInstances();
    this.linkAgents();
    this.forEachMatch(false);
    this.routeFiles();
    this.componentFrameworks();
    return this.inventory;
  }

  /** Imports of the project's own modules are not framework calls, whatever their name. */
  isLocal(ref: CallFact["ref"]): boolean {
    return ref?.kind === "import" && this.isLocalModule(ref.module);
  }

  isLocalModule(module: string): boolean {
    if (this.#language !== "python") return false;
    return module.startsWith(".") || this.#localModules.has(module.split(".")[0] ?? "");
  }

  whereHolds(rule: Rule, args: CallFact["arguments"] | null): boolean {
    if (rule.where === undefined) return true;
    const value = this.literal(select(args, this.#facts, rule.where.path));
    return value !== null && rule.where.equals.includes(value);
  }

  // Matching

  forEachMatch(constructors: boolean): void {
    const facts = this.#facts;
    if (constructors) {
      // Tools first, then what holds them: agents name their tools in arguments.
      this.matchDefinitions(true);
      const tools = (kind: string) => CONSTRUCTORS.has(kind) && kind !== "agent";
      for (const [index, call] of facts.calls.entries()) this.matchCall(call, index, tools);
      for (const [index, call] of facts.calls.entries())
        this.matchCall(call, index, (kind) => kind === "agent");
      return;
    }
    // Tool bindings first, so graph nodes and LLM calls can find their results.
    for (const [index, call] of facts.calls.entries())
      this.matchCall(call, index, (kind) => kind === "tool_binding");
    const relations = (kind: string) => !CONSTRUCTORS.has(kind) && kind !== "tool_binding";
    for (const [index, call] of facts.calls.entries()) this.matchCall(call, index, relations);
    this.matchDefinitions(false);
  }

  matchDefinitions(constructors: boolean): void {
    for (const definition of this.#facts.definitions) {
      for (const decorator of definition.decorators) {
        const name = decorator.ref?.name;
        if (name === undefined || this.isLocal(decorator.ref)) continue;
        for (const { rule, decorators } of this.#rules) {
          if (decorators === null || !decorators.test(name)) continue;
          if (constructors && rule.kind === "tool_decorator")
            this.toolDecorator(rule, definition, decorator);
          if (constructors && rule.kind === "prompt_decorator") {
            const prompt = this.functionPrompt(definition);
            this.#receiverLinks.push({ receiver: decorator.receiver, prompt });
          }
          if (!constructors && rule.kind === "mcp_member")
            this.mcpMemberDecorator(rule, definition, decorator);
          if (!constructors && rule.kind === "route")
            this.routeDecorator(rule, definition, decorator);
        }
      }
      if (!constructors) continue;
      for (const base of definition.bases) {
        const name = base.kind === "name" ? base.ref?.name : undefined;
        if (name === undefined || (base.kind === "name" && this.isLocal(base.ref))) continue;
        for (const { rule, bases } of this.#rules) {
          if (bases?.test(name) && rule.kind === "tool_class") this.toolClass(rule, definition);
        }
      }
    }
  }

  matchCall(call: CallFact, index: number, wanted: (kind: string) => boolean): void {
    const name = call.ref?.name;
    if (name === undefined || this.isLocal(call.ref)) return;
    for (const { rule, calls, invoke } of this.#rules) {
      if (
        rule.kind === "agent" &&
        invoke !== null &&
        wanted("agent_invocation") &&
        invoke.test(name)
      ) {
        this.invocation(rule, call, index);
      }
      if (calls === null || !wanted(rule.kind) || !calls.test(name)) continue;
      if (!this.whereHolds(rule, call.arguments)) continue;
      switch (rule.kind) {
        case "agent_run":
          this.agentRun(rule, call, index);
          break;
        case "tool_builtin":
          this.toolBuiltin(rule, call, index);
          break;
        case "model":
          this.model(rule, call, index);
          break;
        case "agent":
          this.agent(rule, call, index);
          break;
        case "llm_call":
          this.llmCall(rule, call);
          break;
        case "tool_factory":
          this.toolFactory(rule, call, index);
          break;
        case "tool_binding":
          this.toolBinding(rule, call, index);
          break;
        case "graph_node":
          this.graphNode(rule, call);
          break;
        case "mcp_server":
          this.mcpServer(rule.framework, call, index, rule.name);
          break;
        case "mcp_member":
          this.mcpMemberCall(rule, call);
          break;
        case "mcp_transport":
          this.mcpTransport(rule, call);
          break;
        case "mcp_client":
          this.mcpClient(rule, call, index);
          break;
        case "route":
          this.routeCall(rule, call);
          break;
        case "data_store":
          this.inventory.dataStores.push({
            id: this.id("store", call.span),
            framework: rule.framework,
            location: this.location(call.span),
            kind: rule.store,
            target: name,
          });
          break;
        case "prompt":
          for (const value of select(call.arguments, this.#facts, rule.text)) {
            this.prompt(value, rule.role, call.span, null, [], rule.braces === true);
          }
          break;
        default:
          break;
      }
    }
    // Agents run through a variable: `agent.invoke(...)` on an instance plenger built.
    if (wanted("agent_invocation")) {
      const instance = this.instanceOfCall(call);
      const method = /\.([\w$]+)$/.exec(name)?.[1];
      if (
        instance?.kind === "agent" &&
        method !== undefined &&
        instance.rule.invokeMethods?.includes(method)
      ) {
        this.addInvocation(instance.component, call, index, instance.rule.input);
      }
    }
  }

  // Constructors

  model(rule: ModelRule, call: CallFact, index: number): void {
    const facts = this.#facts;
    const model: Model = {
      id: this.id("model", call.span),
      framework: rule.framework,
      location: this.location(call.span),
      target: call.ref?.name ?? call.callee,
      model:
        rule.model === undefined ? null : this.modelName(select(call.arguments, facts, rule.model)),
      baseUrl:
        rule.baseUrl === undefined
          ? null
          : this.firstOf(
              select(call.arguments, facts, rule.baseUrl),
              (value) => urlString(value, facts) ?? environmentValue(value, facts),
            ),
      credential:
        rule.apiKey === undefined
          ? "default"
          : credentialOf(select(call.arguments, facts, rule.apiKey), facts),
    };
    this.inventory.models.push(model);
    this.#instanceByCall.set(index, { kind: "model", component: model, rule });
  }

  agent(rule: AgentRule, call: CallFact, index: number): void {
    const facts = this.#facts;
    const agent: Agent = {
      id: this.id("agent", call.span),
      framework: rule.framework,
      location: this.location(call.span),
      target: call.ref?.name ?? call.callee,
      name: rule.name === undefined ? null : this.literal(select(call.arguments, facts, rule.name)),
      model:
        rule.model === undefined ? null : this.modelName(select(call.arguments, facts, rule.model)),
      tools: [],
      unresolvedTools: 0,
      prompts: [],
      nodes: [],
      delegates: [],
      mcpClients: [],
      invocations: [],
    };
    const variables =
      rule.variables === undefined
        ? []
        : this.strings(select(call.arguments, facts, rule.variables));
    for (const path of rule.system ?? []) {
      for (const value of select(call.arguments, facts, path)) {
        const prompt = this.prompt(
          value,
          "system",
          call.span,
          agent.id,
          variables,
          rule.braces === true,
        );
        if (prompt !== null) agent.prompts.push(prompt.id);
      }
    }
    if (rule.tools !== undefined) {
      const tools = this.toolsFrom(
        select(call.arguments, facts, rule.tools),
        call.span,
        rule.framework,
      );
      agent.tools.push(...tools.ids);
      agent.unresolvedTools += tools.unresolved;
    }
    this.#agentLinks.push({ agent, rule, call });
    this.inventory.agents.push(agent);
    this.#instanceByCall.set(index, { kind: "agent", component: agent, rule });
  }

  toolDecorator(rule: ToolDecoratorRule, definition: DefinitionFact, decorator: Decorator): void {
    if (this.#toolByHandler.has(definition.id)) return;
    const facts = this.#facts;
    const explicitName =
      rule.name === undefined ? null : this.literal(select(decorator.arguments, facts, rule.name));
    const description =
      rule.description === undefined
        ? null
        : this.literal(select(decorator.arguments, facts, rule.description));
    this.addTool({
      id: this.id("tool", definition.span),
      framework: rule.framework,
      location: this.location(definition.span),
      name: explicitName ?? definition.name ?? "<anonymous>",
      description: description ?? definition.doc,
      handler: definition.id,
      params: withoutReceiver(definition),
      via: "decorator",
      server: null,
    });
    const tool = this.#toolByHandler.get(definition.id);
    if (tool !== undefined) this.#receiverLinks.push({ receiver: decorator.receiver, tool });
  }

  toolClass(rule: ToolClassRule, definition: DefinitionFact): void {
    const methods = this.#facts.definitions.filter(
      (candidate) =>
        candidate.parent === definition.id && rule.methods.includes(candidate.name ?? ""),
    );
    const handler = methods[0] ?? null;
    const tool = this.addTool({
      id: this.id("tool", definition.span),
      framework: rule.framework,
      location: this.location(definition.span),
      name: this.classAttribute(definition, "name") ?? definition.name ?? "<anonymous>",
      description: this.classAttribute(definition, "description") ?? definition.doc,
      handler: handler?.id ?? null,
      params: handler === null ? [] : withoutReceiver(handler),
      via: "class",
      server: null,
    });
    this.#toolByClass.set(definition.id, tool);
  }

  toolFactory(rule: ToolFactoryRule, call: CallFact, index: number): void {
    const facts = this.#facts;
    const handlerId = this.functionId(select(call.arguments, facts, rule.handler)[0]);
    const handler = facts.definitions.find((definition) => definition.id === handlerId);
    const explicitName =
      rule.name === undefined ? null : this.literal(select(call.arguments, facts, rule.name));
    const assigned = this.assignedName(index);
    const tool = this.addTool({
      id: this.id("tool", call.span),
      framework: rule.framework,
      location: this.location(call.span),
      name: explicitName ?? assigned ?? handler?.name ?? "<anonymous>",
      description:
        (rule.description === undefined
          ? null
          : this.literal(select(call.arguments, facts, rule.description))) ??
        handler?.doc ??
        null,
      handler: handlerId,
      params: handler === undefined ? [] : withoutReceiver(handler),
      via: "factory",
      server: null,
    });
    if (explicitName === null) this.#defaultNamed.add(tool);
    this.#toolByCall.set(index, tool);
  }

  toolBuiltin(rule: ToolBuiltinRule, call: CallFact, index: number): void {
    const target = call.ref?.name ?? call.callee;
    const name =
      (rule.name === undefined
        ? null
        : this.literal(select(call.arguments, this.#facts, rule.name))) ??
      /([\w$]+)(?:\(\))?$/.exec(target)?.[1] ??
      target;
    const tool = this.addTool({
      id: this.id("tool", call.span),
      framework: rule.framework,
      location: this.location(call.span),
      name,
      description: null,
      handler: null,
      params: [],
      via: "builtin",
      server: null,
    });
    this.#toolByCall.set(index, tool);
  }

  mcpServer(framework: string, call: CallFact, index: number, namePath: string | undefined): void {
    const server: McpServer = {
      id: this.id("mcp", call.span),
      framework,
      location: this.location(call.span),
      name:
        namePath === undefined ? null : this.literal(select(call.arguments, this.#facts, namePath)),
      transport: null,
      tools: [],
      resources: [],
      prompts: [],
    };
    this.inventory.mcpServers.push(server);
    this.#instanceByCall.set(index, { kind: "mcp_server", component: server });
  }

  mcpClient(rule: Extract<Rule, { kind: "mcp_client" }>, call: CallFact, index: number): void {
    const facts = this.#facts;
    const configs: { command: Value[]; args: Value[]; url: Value[] }[] = [];
    if (rule.servers !== undefined) {
      for (const servers of select(call.arguments, facts, rule.servers)) {
        const target = deref(servers, facts);
        if (target.kind !== "object") continue;
        for (const entry of target.entries) {
          const config = [{ keyword: null, value: entry.value }];
          configs.push({
            command: select(config, facts, "#0.command"),
            args: select(config, facts, "#0.args"),
            url: select(config, facts, "#0.url"),
          });
        }
      }
    } else {
      configs.push({
        command: rule.command === undefined ? [] : select(call.arguments, facts, rule.command),
        args: rule.args === undefined ? [] : select(call.arguments, facts, rule.args),
        url: rule.url === undefined ? [] : select(call.arguments, facts, rule.url),
      });
    }
    for (const config of configs) {
      const command = this.literal(config.command);
      const client: McpClient = {
        id: this.id("mcp-client", call.span),
        framework: rule.framework,
        location: this.location(call.span),
        target: call.ref?.name ?? call.callee,
        command: command === null ? null : [command, ...this.strings(config.args)].join(" "),
        url: this.firstOf(config.url, (value) => urlString(value, facts)),
      };
      // `MCPToolset("http://...")` and similar take a URL or a command in one argument.
      if (client.url === null && client.command !== null && /^https?:\/\//.test(client.command)) {
        client.url = client.command;
        client.command = null;
      }
      this.inventory.mcpClients.push(client);
      if (!this.#instanceByCall.has(index)) {
        this.#instanceByCall.set(index, { kind: "mcp_client", component: client });
      }
    }
  }

  // Instances

  /** Maps variables to the components assigned to them, following `compile()`-style chains. */
  linkInstances(): void {
    this.#facts.assignments.forEach((assignment, index) => {
      const value = assignment.value;
      if (value.kind !== "call" || assignment.member !== undefined) return;
      let instance = this.#instanceByCall.get(value.call);
      const call = this.#facts.calls[value.call];
      if (
        instance === undefined &&
        call !== undefined &&
        SAME_INSTANCE.test(`${call.ref?.name ?? ""}()`)
      ) {
        instance = this.instanceOfCall(call);
      }
      if (instance !== undefined) this.#instanceByAssignment.set(index, instance);
    });
  }

  /** Resolves agent delegates and MCP clients, and attaches decorated tools and prompts. */
  linkAgents(): void {
    const facts = this.#facts;
    for (const { agent, rule, call } of this.#agentLinks) {
      if (rule.delegates !== undefined) {
        const delegates = this.instancesIn(select(call.arguments, facts, rule.delegates), "agent");
        agent.delegates = delegates
          .map((instance) => instance.component.id)
          .filter((id) => id !== agent.id);
      }
      if (rule.mcp !== undefined) {
        agent.mcpClients = this.instancesIn(
          select(call.arguments, facts, rule.mcp),
          "mcp_client",
        ).map((instance) => instance.component.id);
      }
    }
    for (const link of this.#receiverLinks) {
      const instance = this.instanceOf(link.receiver);
      if (instance?.kind !== "agent") continue;
      if (link.tool !== undefined) instance.component.tools.push(link.tool.id);
      if (link.prompt !== undefined) {
        instance.component.prompts.push(link.prompt.id);
        link.prompt.usedBy.push(instance.component.id);
      }
    }
  }

  /** Instances of a kind held by values, looking inside lists and object values. */
  instancesIn<K extends Instance["kind"]>(
    values: Value[],
    kind: K,
  ): Extract<Instance, { kind: K }>[] {
    const found: Extract<Instance, { kind: K }>[] = [];
    const visit = (value: Value, depth: number) => {
      const target = deref(value, this.#facts);
      if (target.kind === "list" && depth < 3)
        for (const item of target.items) visit(item, depth + 1);
      else if (target.kind === "object" && depth < 3) {
        for (const entry of target.entries) visit(entry.value, depth + 1);
      } else if (target.kind === "call") {
        const instance = this.#instanceByCall.get(target.call);
        if (instance?.kind === kind) found.push(instance as Extract<Instance, { kind: K }>);
        else if (instance === undefined && depth < 3) {
          // Wrappers such as `handoff(agent)` hold the instance in an argument.
          for (const arg of this.#facts.calls[target.call]?.arguments ?? [])
            visit(arg.value, depth + 1);
        }
      }
    };
    for (const value of values) visit(value, 0);
    return [...new Set(found)];
  }

  instanceOf(receiver: number | undefined): Instance | undefined {
    if (receiver === undefined) return undefined;
    const linked = this.#instanceByAssignment.get(receiver);
    if (linked !== undefined) return linked;
    // Before linkInstances() runs: the variable holds a constructor call plenger matched.
    const value = this.#facts.assignments[receiver]?.value;
    return value?.kind === "call" ? this.#instanceByCall.get(value.call) : undefined;
  }

  /** The model or agent an argument holds, directly or through a variable. */
  instanceIn(values: Value[]): Instance | undefined {
    for (const value of values) {
      const target = deref(value, this.#facts);
      if (target.kind === "call") {
        const instance = this.#instanceByCall.get(target.call);
        if (instance !== undefined) return instance;
      }
    }
    return undefined;
  }

  /**
   * The instance a call is made on: through its receiver variable, or through a
   * constructor earlier in the same chain (`OpenAI().chat.completions.create()`), which
   * starts at the same position.
   */
  instanceOfCall(call: CallFact): Instance | undefined {
    const byReceiver = this.instanceOf(call.receiver);
    if (byReceiver !== undefined) return byReceiver;
    for (const [index, instance] of this.#instanceByCall) {
      const candidate = this.#facts.calls[index];
      if (
        candidate !== call &&
        candidate?.span.line === call.span.line &&
        candidate.span.column === call.span.column
      ) {
        return instance;
      }
    }
    return undefined;
  }

  /** The only instance of a kind in the file, for calls whose receiver plenger could not follow. */
  soleInstance<K extends Instance["kind"]>(kind: K): Extract<Instance, { kind: K }> | undefined {
    const instances = [...new Set(this.#instanceByCall.values())].filter(
      (instance) => instance.kind === kind,
    );
    return instances.length === 1 ? (instances[0] as Extract<Instance, { kind: K }>) : undefined;
  }

  // Relations

  llmCall(rule: LlmCallRule, call: CallFact): void {
    const facts = this.#facts;
    const instance = this.instanceOfCall(call);
    const llm: LlmCall = {
      id: this.id("llm", call.span),
      framework: rule.framework,
      location: this.location(call.span),
      target: call.ref?.name ?? call.callee,
      scope: call.scope,
      model:
        rule.model === undefined ? null : this.modelName(select(call.arguments, facts, rule.model)),
      client:
        instance?.kind === "model" || instance?.kind === "agent" ? instance.component.id : null,
      prompts: [],
      tools: [],
      unresolvedTools: 0,
      inputs: [],
    };
    if (llm.model === null && (instance?.kind === "model" || instance?.kind === "agent")) {
      llm.model = instance.component.model;
    }
    if (llm.client === null && rule.model !== undefined) {
      // `generateText({ model: openai("gpt-4.1") })`: the model object is an argument.
      const holder = this.instanceIn(select(call.arguments, facts, rule.model));
      llm.client =
        holder?.kind === "model" || holder?.kind === "agent" ? holder.component.id : null;
    }
    for (const path of rule.system ?? []) {
      for (const value of select(call.arguments, facts, path)) {
        const prompt = this.prompt(value, "system", call.span, llm.id);
        if (prompt !== null) llm.prompts.push(prompt.id);
      }
    }
    if (instance?.kind === "agent") {
      for (const id of instance.component.prompts) {
        llm.prompts.push(id);
        this.inventory.prompts.find((prompt) => prompt.id === id)?.usedBy.push(llm.id);
      }
      llm.tools.push(...instance.component.tools);
    }
    if (rule.tools !== undefined) {
      const tools = this.toolsFrom(
        select(call.arguments, facts, rule.tools),
        call.span,
        rule.framework,
      );
      llm.tools.push(...tools.ids);
      llm.unresolvedTools += tools.unresolved;
    }
    llm.tools.push(...(this.#bindings.get(this.boundThrough(call)) ?? []));
    if (call.receiver !== undefined)
      llm.tools.push(...(this.#bindings.get(-1 - call.receiver) ?? []));
    llm.tools = [...new Set(llm.tools)];

    const inputs: DynamicPart[] = [];
    for (const path of rule.user ?? []) {
      for (const value of select(call.arguments, facts, path)) inputs.push(...this.inputs(value));
    }
    if (rule.keywordInputs) {
      for (const arg of call.arguments)
        if (arg.keyword !== null) inputs.push(...this.inputs(arg.value));
    }
    llm.inputs = uniqueParts(inputs);
    this.inventory.llmCalls.push(llm);
  }

  /**
   * The `bind_tools()` call a chained call goes through (`model.bind_tools(t).invoke()`),
   * found as the call that starts at the same position; -1 when there is none.
   */
  boundThrough(call: CallFact): number {
    return this.#facts.calls.findIndex(
      (candidate) =>
        candidate !== call &&
        candidate.span.line === call.span.line &&
        candidate.span.column === call.span.column &&
        this.#bindings.has(this.#facts.calls.indexOf(candidate)),
    );
  }

  toolBinding(rule: ToolBindingRule, call: CallFact, index: number): void {
    const tools = this.toolsFrom(
      select(call.arguments, this.#facts, rule.tools),
      call.span,
      rule.framework,
    );
    this.#bindings.set(index, tools.ids);
    const instance = this.instanceOf(call.receiver);
    if (instance?.kind === "agent") {
      // `register_tool` changes the agent itself.
      instance.component.tools = [...new Set([...instance.component.tools, ...tools.ids])];
      instance.component.unresolvedTools += tools.unresolved;
    }
    // `bound = model.bind_tools(tools)`: calls through `bound` use these tools.
    const assignment = this.#assignmentOfCall.get(index);
    if (assignment !== undefined) this.#bindings.set(-1 - assignment, tools.ids);
  }

  graphNode(rule: GraphNodeRule, call: CallFact): void {
    const facts = this.#facts;
    const agent = (this.instanceOfCall(call) ?? this.soleInstance("agent"))?.component;
    if (agent === undefined || !("nodes" in agent)) return;
    let name = this.literal(select(call.arguments, facts, rule.name));
    let handlerValue = select(call.arguments, facts, rule.handler)[0];
    if (name === null) {
      // `add_node(fn)` names the node after the function.
      handlerValue = select(call.arguments, facts, rule.name)[0];
    }
    const handler = this.functionId(handlerValue);
    name ??= facts.definitions.find((definition) => definition.id === handler)?.name ?? "<node>";
    // Chained `.addNode()` calls are recorded outermost first; keep source order.
    const node = { name, handler };
    this.#nodeOrder.set(node, call.span.endLine * 1e6 + call.span.endColumn);
    agent.nodes.push(node);
    agent.nodes.sort((a, b) => (this.#nodeOrder.get(a) ?? 0) - (this.#nodeOrder.get(b) ?? 0));
    const target = handlerValue === undefined ? undefined : deref(handlerValue, facts);
    const bound = target?.kind === "call" ? this.#bindings.get(target.call) : undefined;
    if (bound !== undefined) agent.tools = [...new Set([...agent.tools, ...bound])];
  }

  /** A call matching an agent rule's run pattern runs the instance it was made on, or the file's agent from that rule. */
  invocation(rule: AgentRule, call: CallFact, index: number): void {
    const instance = this.instanceOfCall(call);
    const agent =
      instance?.kind === "agent"
        ? instance.component
        : [...this.#instanceByCall.values()]
            .filter((candidate) => candidate.kind === "agent" && candidate.rule === rule)
            .at(-1)?.component;
    if (agent !== undefined && "invocations" in agent)
      this.addInvocation(agent, call, index, rule.input);
  }

  /** `Runner.run(agent, input)`: the agent is an argument, not the receiver. */
  agentRun(rule: AgentRunRule, call: CallFact, index: number): void {
    const [instance] = this.instancesIn(select(call.arguments, this.#facts, rule.agent), "agent");
    if (instance !== undefined) this.addInvocation(instance.component, call, index, rule.input);
  }

  addInvocation(agent: Agent, call: CallFact, index: number, inputPaths: string[] = []): void {
    let seen = this.#invocations.get(agent);
    if (seen === undefined) {
      seen = new Set();
      this.#invocations.set(agent, seen);
    }
    if (seen.has(index)) return;
    seen.add(index);
    const inputs: DynamicPart[] = [];
    for (const path of inputPaths) {
      for (const value of select(call.arguments, this.#facts, path))
        inputs.push(...this.inputs(value));
    }
    agent.invocations.push({ location: this.location(call.span), inputs: uniqueParts(inputs) });
  }

  mcpMemberDecorator(rule: McpMemberRule, definition: DefinitionFact, decorator: Decorator): void {
    const facts = this.#facts;
    const server = this.serverFor(decorator.receiver);
    const name =
      (rule.name === undefined
        ? null
        : this.literal(select(decorator.arguments, facts, rule.name))) ??
      definition.name ??
      "<anonymous>";
    const description =
      (rule.description === undefined
        ? null
        : this.literal(select(decorator.arguments, facts, rule.description))) ?? definition.doc;
    this.addMember(
      rule,
      server,
      name,
      description,
      definition.id,
      definition.span,
      withoutReceiver(definition),
    );
  }

  mcpMemberCall(rule: McpMemberRule, call: CallFact): void {
    const facts = this.#facts;
    const server = this.serverFor(call.receiver);
    const handlerId =
      rule.handler === undefined
        ? null
        : this.functionId(select(call.arguments, facts, rule.handler)[0]);
    const handler = facts.definitions.find((definition) => definition.id === handlerId);
    const name =
      (rule.name === undefined ? null : this.literal(select(call.arguments, facts, rule.name))) ??
      handler?.name ??
      "<anonymous>";
    const description =
      (rule.description === undefined
        ? null
        : this.literal(select(call.arguments, facts, rule.description))) ??
      handler?.doc ??
      null;
    this.addMember(
      rule,
      server,
      name,
      description,
      handlerId,
      call.span,
      handler === undefined ? [] : withoutReceiver(handler),
    );
  }

  serverFor(receiver: number | undefined): McpServer | undefined {
    const instance = this.instanceOf(receiver);
    return instance?.kind === "mcp_server"
      ? instance.component
      : this.soleInstance("mcp_server")?.component;
  }

  addMember(
    rule: McpMemberRule,
    server: McpServer | undefined,
    name: string,
    description: string | null,
    handler: string | null,
    span: Span,
    params: string[],
  ): void {
    if (rule.member === "tool") {
      const tool = this.addTool({
        id: this.id("tool", span),
        framework: rule.framework,
        location: this.location(span),
        name,
        description,
        handler,
        params,
        via: "mcp",
        server: server?.id ?? null,
      });
      server?.tools.push(tool.id);
      return;
    }
    const member = { name, handler, location: this.location(span) };
    if (rule.member === "resource") server?.resources.push(member);
    else server?.prompts.push(member);
  }

  mcpTransport(rule: McpTransportRule, call: CallFact): void {
    const server = this.serverFor(call.receiver);
    if (server === undefined) return;
    let transport = rule.fixed;
    if (rule.transport !== undefined) {
      const [value] = select(call.arguments, this.#facts, rule.transport);
      const target = value === undefined ? undefined : deref(value, this.#facts);
      const text =
        target?.kind === "call"
          ? (this.#facts.calls[target.call]?.ref?.name ?? "")
          : (this.literal(value === undefined ? [] : [value]) ?? "");
      if (/stdio/i.test(text)) transport = "stdio";
      else if (/streamable|http/i.test(text)) transport = "streamable-http";
      else if (/sse/i.test(text)) transport = "sse";
    }
    server.transport = transport;
  }

  routeDecorator(rule: RouteRule, definition: DefinitionFact, decorator: Decorator): void {
    const name = decorator.ref?.name ?? "";
    this.addRoute(rule, name, decorator.arguments, definition.id, decorator.span);
  }

  routeCall(rule: RouteRule, call: CallFact): void {
    const handler =
      rule.handler === undefined
        ? null
        : this.functionId(select(call.arguments, this.#facts, rule.handler).at(-1));
    this.addRoute(rule, call.ref?.name ?? "", call.arguments, handler, call.span);
  }

  addRoute(
    rule: RouteRule,
    target: string,
    args: CallFact["arguments"] | null,
    handler: string | null,
    span: Span,
  ): void {
    const facts = this.#facts;
    const path = this.literal(select(args, facts, rule.path));
    const segment = /([\w$]+)(?:\(\))?$/.exec(target)?.[1]?.toLowerCase() ?? "";
    const explicit =
      rule.methods === undefined ? [] : this.strings(select(args, facts, rule.methods));
    let methods: string[];
    if (explicit.length > 0) methods = explicit.map((method) => method.toUpperCase());
    else if (["route", "add_url_rule"].includes(segment)) methods = ["GET"];
    else if (
      [
        "all",
        "api_route",
        "add_api_route",
        "path",
        "re_path",
        "websocket",
        "add_api_websocket_route",
      ].includes(segment)
    ) {
      methods = [segment.includes("websocket") ? "WEBSOCKET" : "*"];
    } else methods = [segment.toUpperCase()];
    for (const method of methods) {
      const entry: EntryPoint = {
        id: this.id("route", span),
        framework: rule.framework,
        location: this.location(span),
        kind: "http",
        method,
        path,
        handler,
      };
      this.inventory.entryPoints.push(entry);
    }
  }

  /** Next.js App Router `route.ts` handlers and Pages Router API routes. */
  routeFiles(): void {
    if (this.#language === "python") return;
    const app = /(?:^|\/)app\/((?:[^/]+\/)*)route\.[cm]?[jt]sx?$/.exec(this.#path);
    const pages = /(?:^|\/)pages\/api\/(.+)\.[cm]?[jt]sx?$/.exec(this.#path);
    if (app === null && pages === null) return;
    const exported = this.#facts.definitions.filter(
      (definition) => definition.parent === null && definition.exported,
    );
    const add = (method: string, path: string, definition: DefinitionFact) =>
      this.inventory.entryPoints.push({
        id: this.id("route", definition.span),
        framework: "nextjs",
        location: this.location(definition.span),
        kind: "http",
        method,
        path,
        handler: definition.id,
      });
    if (app !== null) {
      const segments = (app[1] ?? "")
        .split("/")
        .filter((segment) => segment !== "" && !/^\(.*\)$|^@/.test(segment));
      for (const definition of exported) {
        if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(definition.name ?? "")) {
          add(definition.name as string, `/${segments.join("/")}`, definition);
        }
      }
    }
    if (pages !== null) {
      const route = (pages[1] ?? "").replace(/(?:^|\/)index$/, "");
      for (const definition of exported.filter((candidate) => candidate.name === "default")) {
        add("*", `/api${route === "" ? "" : `/${route}`}`, definition);
      }
    }
    if (this.inventory.entryPoints.some((entry) => entry.framework === "nextjs")) {
      this.addFramework("nextjs");
    }
  }

  // Tools

  addTool(tool: Tool): Tool {
    this.inventory.tools.push(tool);
    if (tool.handler !== null && !this.#toolByHandler.has(tool.handler))
      this.#toolByHandler.set(tool.handler, tool);
    return tool;
  }

  /** Tools named in a tools argument: a list, a `{ name: tool }` object, or tool schemas. */
  toolsFrom(values: Value[], span: Span, framework: string): { ids: string[]; unresolved: number } {
    const ids: string[] = [];
    let unresolved = 0;
    const visit = (value: Value, key: string | null, depth: number) => {
      const target = deref(value, this.#facts);
      if (target.kind === "list" && depth < 3) {
        for (const item of target.items) visit(item, null, depth + 1);
        return;
      }
      if (target.kind === "object" && !isSchema(target) && depth < 3) {
        for (const entry of target.entries) visit(entry.value, entry.key, depth + 1);
        return;
      }
      const tool = this.toolOf(target, key, span, framework);
      if (tool === undefined) unresolved++;
      else ids.push(tool.id);
    };
    for (const value of values) visit(value, null, 0);
    return { ids: [...new Set(ids)], unresolved };
  }

  toolOf(value: Value, key: string | null, span: Span, framework: string): Tool | undefined {
    let tool: Tool | undefined;
    if (value.kind === "name" && value.ref?.kind === "local" && value.ref.path === "") {
      tool =
        this.#toolByHandler.get(value.ref.definition) ??
        this.#toolByClass.get(value.ref.definition) ??
        this.functionTool(value.ref.definition, framework);
    } else if (value.kind === "function") {
      tool = this.#toolByHandler.get(value.definition);
    } else if (value.kind === "call") {
      tool = this.#toolByCall.get(value.call) ?? this.agentTool(value.call, framework);
      const ref = this.#facts.calls[value.call]?.ref;
      if (tool === undefined && ref?.kind === "local" && ref.path === "")
        tool = this.#toolByClass.get(ref.definition);
    } else if (value.kind === "object" && isSchema(value)) {
      tool = this.schemaTool(value, span);
    }
    if (tool !== undefined && key !== null && this.#defaultNamed.has(tool)) {
      tool.name = key;
      this.#defaultNamed.delete(tool);
    }
    return tool;
  }

  /** `agent.as_tool(...)` / `agent.asTool(...)`: another agent exposed as a tool. */
  agentTool(callIndex: number, framework: string): Tool | undefined {
    const call = this.#facts.calls[callIndex];
    if (call === undefined || !/\.(?:as_tool|asTool)$/.test(call.ref?.name ?? "")) return undefined;
    const instance = this.instanceOfCall(call);
    if (instance?.kind !== "agent") return undefined;
    const facts = this.#facts;
    const tool = this.addTool({
      id: this.id("tool", call.span),
      framework,
      location: this.location(call.span),
      name:
        this.literal(select(call.arguments, facts, "tool_name|toolName")) ??
        instance.component.name ??
        "<agent>",
      description: this.literal(select(call.arguments, facts, "tool_description|toolDescription")),
      handler: null,
      params: [],
      via: "agent",
      server: null,
      agent: instance.component.id,
    });
    this.#toolByCall.set(callIndex, tool);
    return tool;
  }

  /** A plain function passed in a tool list: the framework builds the tool from its signature and docstring. */
  functionTool(definitionId: string, framework: string): Tool | undefined {
    const definition = this.#facts.definitions.find((candidate) => candidate.id === definitionId);
    if (definition === undefined || definition.kind === "class" || definition.name === null)
      return undefined;
    return this.addTool({
      id: this.id("tool", definition.span),
      framework,
      location: this.location(definition.span),
      name: definition.name,
      description: definition.doc,
      handler: definition.id,
      params: withoutReceiver(definition),
      via: "function",
      server: null,
    });
  }

  /** A JSON tool schema (`{"name": ..., "input_schema": ...}` or `{"type": "function", ...}`). */
  schemaTool(value: Extract<Value, { kind: "object" }>, span: Span): Tool | undefined {
    const facts = this.#facts;
    const entry = (path: string) => this.literal(select([{ keyword: null, value }], facts, path));
    const name = entry("#0.name|#0.function.name");
    if (name === null) return undefined;
    const existing = this.inventory.tools.find(
      (tool) => tool.via === "schema" && tool.name === name && tool.location.line === span.line,
    );
    if (existing !== undefined) return existing;
    const handler = facts.definitions.find(
      (definition) => definition.name === name && definition.kind !== "class",
    );
    return this.addTool({
      id: this.id("tool", span),
      framework: this.frameworkAt(span),
      location: this.location(span),
      name,
      description: entry("#0.description|#0.function.description"),
      handler: handler?.id ?? null,
      params: handler === undefined ? [] : withoutReceiver(handler),
      via: "schema",
      server: null,
    });
  }

  frameworkAt(span: Span): string {
    const call = this.#facts.calls.find(
      (candidate) => candidate.span.line === span.line && candidate.span.column === span.column,
    );
    const name = call?.ref?.name ?? "";
    return name.startsWith("anthropic") || name.startsWith("@anthropic-ai")
      ? "anthropic"
      : "openai";
  }

  // Prompts and inputs

  prompt(
    value: Value,
    role: Prompt["role"],
    span: Span,
    usedBy: string | null,
    declared: string[] = [],
    braces = role === "template",
  ): Prompt | null {
    const facts = this.#facts;
    const summary = summarizeText(value, facts);
    if (summary === null || summary.text.trim() === "") return null;
    const origin = summary.origin === null ? undefined : facts.assignments[summary.origin];
    const at = origin?.span ?? span;
    const key = `${at.line}:${at.column}:${role}:${summary.text}`;
    let prompt = this.#prompts.get(key);
    if (prompt === undefined) {
      const variables = new Set(declared);
      for (const fixed of summary.fixed) {
        for (const match of fixed.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g))
          variables.add(match[1] as string);
        if (braces) {
          for (const match of fixed.matchAll(/(?<!\{)\{([A-Za-z_]\w*)\}(?!\})/g))
            variables.add(match[1] as string);
        }
      }
      prompt = {
        id: this.id("prompt", at),
        location: this.location(at),
        role,
        text: summary.text,
        dynamic: uniqueParts(summary.dynamic),
        variables: [...variables],
        usedBy: [],
      };
      if (summary.truncated) prompt.truncated = true;
      this.#prompts.set(key, prompt);
      this.inventory.prompts.push(prompt);
    } else {
      for (const variable of declared)
        if (!prompt.variables.includes(variable)) prompt.variables.push(variable);
    }
    if (usedBy !== null && !prompt.usedBy.includes(usedBy)) prompt.usedBy.push(usedBy);
    return prompt;
  }

  /** A system prompt produced by a function (`@agent.system_prompt`): its text is only known at run time. */
  functionPrompt(definition: DefinitionFact): Prompt {
    const name = definition.name ?? "<anonymous>";
    const prompt: Prompt = {
      id: this.id("prompt", definition.span),
      location: this.location(definition.span),
      role: "system",
      text: `{${name}()}`,
      dynamic: [{ text: `${name}()`, source: "call", ref: definition.id }],
      variables: [],
      usedBy: [],
    };
    this.inventory.prompts.push(prompt);
    return prompt;
  }

  inputs(value: Value): DynamicPart[] {
    const summary = summarizeText(value, this.#facts);
    if (summary !== null) return summary.dynamic;
    const target = deref(value, this.#facts);
    if (target.kind === "name" || target.kind === "call") return [dynamicPart(target, this.#facts)];
    return [];
  }

  // Helpers

  frameworks(): void {
    const unrecognised = new Set<string>();
    for (const fact of this.#facts.imports) {
      if (this.isLocalModule(fact.module)) continue;
      const framework = frameworkOfModule(fact.module, this.#language);
      if (framework !== undefined) this.addFramework(framework.id);
      const unsupported = unsupportedModule(fact.module, this.#language);
      if (unsupported !== undefined) unrecognised.add(unsupported.replace(/\/\*$/, ""));
    }
    for (const module of unrecognised)
      this.inventory.unrecognised.push({ module, files: [this.#path] });
  }

  /** Frameworks seen only through components (`boto3` calls to Bedrock). */
  componentFrameworks(): void {
    const inventory = this.inventory;
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
    this.inventory.frameworks.push({ id, name: info?.name ?? id, files: [this.#path] });
  }

  literal(values: Value[]): string | null {
    for (const value of values) {
      const text = literalString(value, this.#facts);
      if (text !== null) return text;
    }
    return null;
  }

  firstOf(values: Value[], read: (value: Value) => string | null): string | null {
    for (const value of values) {
      const text = read(value);
      if (text !== null) return text;
    }
    return null;
  }

  /**
   * A model name given directly, from the environment, through a variable, or
   * through a model object or provider call plenger detected.
   */
  modelName(values: Value[]): string | null {
    for (const value of values) {
      const text = literalString(value, this.#facts) ?? environmentValue(value, this.#facts);
      if (text !== null) return text;
      const target = deref(value, this.#facts);
      if (target.kind === "call") {
        const instance = this.#instanceByCall.get(target.call);
        if (instance?.kind === "model" && instance.component.model !== null)
          return instance.component.model;
      }
    }
    return null;
  }

  strings(values: Value[]): string[] {
    const result: string[] = [];
    for (const value of values) {
      const target = deref(value, this.#facts);
      const items = target.kind === "list" ? target.items : [target];
      for (const item of items) {
        const text = literalString(item, this.#facts);
        if (text !== null) result.push(text);
      }
    }
    return result;
  }

  functionId(value: Value | undefined): string | null {
    if (value === undefined) return null;
    const target = deref(value, this.#facts);
    if (target.kind === "function") return target.definition;
    if (target.kind === "name" && target.ref?.kind === "local" && target.ref.path === "")
      return target.ref.definition;
    return null;
  }

  assignedName(callIndex: number): string | null {
    const assignment = this.#assignmentOfCall.get(callIndex);
    if (assignment === undefined) return null;
    const target = this.#facts.assignments[assignment]?.target ?? "";
    return /([\w$#]+)$/.exec(target)?.[1] ?? null;
  }

  classAttribute(definition: DefinitionFact, name: string): string | null {
    const assignment = this.#facts.assignments.find(
      (candidate) => candidate.scope === definition.id && candidate.target === name,
    );
    return assignment === undefined ? null : this.literal([assignment.value]);
  }

  location(span: Span): Location {
    return { path: this.#path, ...span };
  }

  id(kind: string, span: Span): string {
    const base = `${kind}:${this.#path}:${span.line}:${span.column}`;
    let id = base;
    for (let n = 2; this.#ids.has(id); n++) id = `${base}#${n}`;
    this.#ids.add(id);
    return id;
  }
}

function withoutReceiver(definition: DefinitionFact): string[] {
  const [first, ...rest] = definition.params;
  return definition.kind === "method" && (first === "self" || first === "cls")
    ? rest
    : definition.params;
}

function isSchema(value: Extract<Value, { kind: "object" }>): boolean {
  const keys = new Set(value.entries.map((entry) => entry.key));
  return (
    (keys.has("name") &&
      (keys.has("input_schema") || keys.has("parameters") || keys.has("description"))) ||
    (keys.has("type") && keys.has("function"))
  );
}

function uniqueParts(parts: DynamicPart[]): DynamicPart[] {
  const seen = new Set<string>();
  return parts.filter((part) => {
    const key = `${part.source}:${part.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
