import type { PublicFunction } from "../capabilities/library.ts";
import type { CallFact } from "../facts/model.ts";
import { isEnabled, select } from "../facts/query.ts";
import type {
  Agent,
  Capability,
  CapabilityKind,
  DynamicPart,
  Inventory,
  LlmCall,
  Location,
  McpServer,
  Tool,
} from "../inventory/model.ts";
import { ProjectIndex } from "../project/index.ts";
import type { Project, ProjectFile } from "../project/project.ts";
import { locationKey, sameStart } from "../shared/location.ts";
import { routeLabel, shortName } from "../shared/text.ts";
import type { Evidence } from "./model.ts";
import { code, UNNAMED } from "./text.ts";

/** Handler parameters that frameworks fill in rather than the model. */
const CONTEXT_PARAMS =
  /^(?:ctx|run_context|wrapper|run_manager|callbacks|config|runtime|tool_call_id|_?context_?variables)$/;
/** MCP server options that turn on authentication. */
const AUTH_OPTIONS = [
  "auth",
  "auth_server_provider",
  "token_verifier",
  "authenticate",
  "authorization",
  "oauth",
];
/** Modules whose import means a file sets up MCP authentication. */
const AUTH_MODULE =
  /^(?:mcp\.server\.auth|fastmcp\.server\.auth|@modelcontextprotocol\/sdk\/server\/auth)(?:[./]|$)/;
/** MCP transports that accept connections over the network. */
export const NETWORK_TRANSPORT = /^(?:streamable-http|sse|http)$/;

/** Capabilities an agent should not use unattended. */
const HIGH_IMPACT = new Set<CapabilityKind>([
  "process",
  "code",
  "file_write",
  "file_delete",
  "payment",
  "message",
  "database",
  "deserialize",
]);

const DATABASE_READ = /\.(?:find\w*|select|aggregate|query_?\w*|get|fetch\w*|count\w*)$/i;

/** What every check can look at, with lookups shared between checks. */
export class RuleContext {
  readonly project: Project;
  readonly inventory: Inventory;
  /** In a library scan, the public functions and methods and what they reach; otherwise empty. */
  readonly functions: PublicFunction[];
  readonly tools: Map<string, Tool>;
  readonly agents: Map<string, Agent>;
  readonly llmCalls: Map<string, LlmCall>;
  /** Items reachable from outside (tool, agent and LLM call ids) and the route or server that reaches them. */
  readonly exposure = new Map<string, string>();
  readonly #index: ProjectIndex;

  constructor(project: Project, inventory: Inventory, functions: PublicFunction[] = []) {
    this.project = project;
    this.#index = new ProjectIndex(project);
    this.inventory = inventory;
    this.functions = functions;
    this.tools = new Map(inventory.tools.map((tool) => [tool.id, tool]));
    this.agents = new Map(inventory.agents.map((agent) => [agent.id, agent]));
    this.llmCalls = new Map(inventory.llmCalls.map((call) => [locationKey(call.location), call]));
    this.#exposure();
  }

  /** Marks what HTTP routes reach and what network MCP servers serve. */
  #exposure(): void {
    const mark = (id: string, label: string) => {
      if (this.exposure.has(id)) return false;
      this.exposure.set(id, label);
      return true;
    };
    const markAgent = (id: string, label: string) => {
      const agent = this.agents.get(id);
      if (agent === undefined || !mark(id, label)) return;
      for (const toolId of agent.tools) {
        mark(toolId, label);
        const tool = this.tools.get(toolId);
        if (tool?.agent !== undefined) markAgent(tool.agent, label);
      }
      for (const delegate of agent.delegates) markAgent(delegate, label);
    };
    for (const entry of this.inventory.entryPoints) {
      const label = routeLabel(entry);
      for (const capability of entry.reaches) {
        if (capability.kind === "agent") markAgent(capability.target, label);
        if (capability.kind !== "llm") continue;
        const call = this.llmCalls.get(locationKey(capability.location));
        if (call === undefined) continue;
        mark(call.id, label);
        for (const toolId of call.tools) mark(toolId, label);
        if (call.client !== null) markAgent(call.client, label);
      }
    }
    for (const server of this.inventory.mcpServers) {
      if (server.transport === null || !NETWORK_TRANSPORT.test(server.transport)) continue;
      if (this.serverAuth(server) !== null) continue;
      const label = `MCP server ${server.name ?? UNNAMED} (${server.transport})`;
      for (const toolId of server.tools) mark(toolId, label);
    }
  }

  /** How an MCP server authenticates clients, when plenger sees it: an option or an auth import in its file. */
  serverAuth(server: McpServer): string | null {
    const imports = this.project.files.get(server.location.path)?.facts.imports ?? [];
    const imported = imports.find((fact) => AUTH_MODULE.test(fact.module));
    if (imported !== undefined) return imported.module;
    const site = this.callAt(server.location);
    if (site === undefined) return null;
    return (
      AUTH_OPTIONS.find((option) =>
        isEnabled(select(site.call.arguments, site.file.facts, option)[0], site.file.facts),
      ) ?? null
    );
  }

  /** Parameters of a tool that the model fills in. */
  modelParams(tool: Tool): Set<string> {
    return new Set(tool.params.filter((param) => !CONTEXT_PARAMS.test(param)));
  }

  /** The parts of a tool effect's input that come from arguments the model chooses. */
  modelInputs(tool: Tool, parts: DynamicPart[] | undefined): DynamicPart[] {
    const params = this.modelParams(tool);
    return (parts ?? []).filter((part) => part.from?.some((name) => params.has(name)));
  }

  /** The parts of an effect reached from a route handler that come from the request. */
  requestInputs(parts: DynamicPart[] | undefined): DynamicPart[] {
    return (parts ?? []).filter((part) => part.from !== undefined && part.from.length > 0);
  }

  /**
   * High-impact capabilities an agent can use through its tools, delegates and
   * agents-as-tools, leaving out hosted and sandboxed ones.
   */
  agentActions(agent: Agent, seen = new Set<string>()): Capability[] {
    if (seen.has(agent.id)) return [];
    seen.add(agent.id);
    const actions = agent.capabilities.filter((capability) => this.isAction(capability));
    for (const capability of agent.capabilities) {
      if (capability.kind !== "agent") continue;
      const delegate = this.agents.get(capability.target);
      if (delegate !== undefined) actions.push(...this.agentActions(delegate, seen));
    }
    return actions;
  }

  /** High-impact capabilities of the tools an LLM call (or the agent it is made through) offers. */
  callActions(call: LlmCall): Capability[] {
    const actions: Capability[] = [];
    for (const id of call.tools) {
      for (const capability of this.tools.get(id)?.capabilities ?? [])
        if (this.isAction(capability)) actions.push({ ...capability, tool: id });
    }
    const agent = call.client === null ? undefined : this.agents.get(call.client);
    if (agent !== undefined) actions.push(...this.agentActions(agent));
    return actions;
  }

  /** A capability that changes things outside the program and is not hosted or sandboxed. */
  isAction(capability: Capability): boolean {
    if (!HIGH_IMPACT.has(capability.kind) || capability.hosted) return false;
    if (
      capability.kind === "code" &&
      capability.sandbox !== undefined &&
      capability.sandbox !== "none"
    )
      return false;
    if (
      capability.kind === "database" &&
      (capability.operation === "read" ||
        (!capability.query && DATABASE_READ.test(capability.target)))
    )
      return false;
    return true;
  }

  /** Whether a person approves the action: on its tool, or on the agent that uses it. */
  approved(capability: Capability, agent?: Agent): boolean {
    if (agent?.approval !== undefined) return true;
    const tool = capability.tool === undefined ? undefined : this.tools.get(capability.tool);
    return tool?.approval !== undefined;
  }

  /** The agent's name, or the variable it is assigned to, or its constructor. */
  agentName(agent: Agent): string {
    if (agent.name !== null) return agent.name;
    const site = this.callAt(agent.location, agent.target);
    if (site !== undefined) {
      const facts = site.file.facts;
      const index = facts.calls.indexOf(site.call);
      // The variable holds the agent call, or the end of a chain that starts with it (`new StateGraph(...).addNode(...)`).
      const assignment = facts.assignments.find((candidate) => {
        if (candidate.value.kind !== "call" || candidate.member !== undefined) return false;
        const span = facts.calls[candidate.value.call]?.span;
        return (
          candidate.value.call === index || (span !== undefined && sameStart(span, site.call.span))
        );
      });
      if (assignment !== undefined) return assignment.target.replace(/^(?:self|this)\./, "");
      // `def build_agent(): return create_react_agent(...)` names the agent after its builder.
      const builder = site.file.facts.definitions.find((definition) =>
        definition.returns?.some((value) => value.kind === "call" && value.call === index),
      );
      if (builder?.name) return `${builder.name}()`;
    }
    return shortName(agent.target);
  }

  /** Evidence for the call sites between a handler and an effect. */
  via(locations: Location[]): Evidence[] {
    return locations.map((location) => {
      const callee = this.callAt(location)?.call.callee;
      return {
        location,
        message: callee === undefined ? "calls on" : `calls ${code(`${callee}()`)}`,
      };
    });
  }

  /** Calls that start at a location (the calls of a chain share their start). */
  callsAt(location: Location): { file: ProjectFile; calls: CallFact[] } | undefined {
    return this.#index.callsAt(location);
  }

  /** The call an inventory item was found at, preferring the one with the item's target. */
  callAt(location: Location, target?: string): { file: ProjectFile; call: CallFact } | undefined {
    return this.#index.callAt(location, target);
  }
}

/** Ordered roughly by how much damage misuse can do. */
const ACTION_ORDER: CapabilityKind[] = [
  "process",
  "code",
  "payment",
  "file_delete",
  "file_write",
  "database",
  "deserialize",
  "message",
  "browser",
  "network",
  "file_read",
  "secret",
  "mcp",
  "agent",
  "llm",
];

/** The kinds of a list of capabilities, most dangerous first. */
export function actionKinds(capabilities: Capability[]): CapabilityKind[] {
  const kinds = new Set(capabilities.map((capability) => capability.kind));
  return ACTION_ORDER.filter((kind) => kinds.has(kind));
}
