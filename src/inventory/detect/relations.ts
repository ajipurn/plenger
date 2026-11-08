/**
 * Rules that relate components: LLM calls to their clients, tools bound to models,
 * graph nodes, agent runs, and the delegates, MCP clients, tools and prompts an agent gets.
 */

import type { CallFact } from "../../facts/model.ts";
import { callsStartingAt, type DynamicPart, deref, select } from "../../facts/query.ts";
import type {
  AgentRule,
  AgentRunRule,
  GraphNodeRule,
  LlmCallRule,
  ToolBindingRule,
} from "../detectors.ts";
import type { Agent, LlmCall } from "../model.ts";
import type { FileDetector } from "./file-detector.ts";
import type { Instance } from "./instances.ts";
import { uniqueParts } from "./prompts.ts";

/** The name of a graph node whose handler plenger could not name. */
const UNNAMED_NODE = "<node>";

/** The tool bindings, node order and run calls of one file. */
export class Relations {
  readonly #d: FileDetector;
  /** Tools bound by a `bind_tools`-style call, by the index of that call. */
  readonly #bindingsByCall = new Map<number, string[]>();
  /** Tools bound by a call whose result was assigned (`bound = model.bind_tools(t)`), by the assignment. */
  readonly #bindingsByAssignment = new Map<number, string[]>();
  readonly #invocations = new Map<Agent, Set<number>>();
  readonly #nodeOrder = new WeakMap<object, number>();

  constructor(d: FileDetector) {
    this.#d = d;
  }

  llmCall(rule: LlmCallRule, call: CallFact): void {
    const d = this.#d;
    const { scope, facts } = d;
    const instance = d.instances.instanceOfCall(call);
    const llm: LlmCall = {
      id: scope.id("llm", call.span),
      framework: rule.framework,
      location: scope.location(call.span),
      target: call.ref?.name ?? call.callee,
      scope: call.scope,
      model:
        rule.model === undefined ? null : d.modelName(select(call.arguments, facts, rule.model)),
      client:
        instance?.kind === "model" || instance?.kind === "agent" ? instance.component.id : null,
      prompts: [],
      tools: [],
      unresolvedTools: 0,
      inputs: [],
      systemInputs: [],
      outputEffects: [],
    };
    if (llm.model === null && (instance?.kind === "model" || instance?.kind === "agent")) {
      llm.model = instance.component.model;
    }
    if (llm.client === null && rule.model !== undefined) {
      // `generateText({ model: openai("gpt-4.1") })`: the model object is an argument.
      const holder = d.instances.instanceIn(select(call.arguments, facts, rule.model));
      llm.client =
        holder?.kind === "model" || holder?.kind === "agent" ? holder.component.id : null;
    }
    for (const path of rule.system ?? []) {
      for (const value of select(call.arguments, facts, path)) {
        const prompt = d.prompts.prompt(value, "system", call, llm.id);
        if (prompt !== null) llm.prompts.push(prompt.id);
      }
    }
    if (instance?.kind === "agent") {
      for (const id of instance.component.prompts) {
        llm.prompts.push(id);
        d.inventory.prompts.find((prompt) => prompt.id === id)?.usedBy.push(llm.id);
      }
      llm.tools.push(...instance.component.tools);
    }
    if (rule.tools !== undefined) {
      const tools = d.tools.toolsFrom(
        select(call.arguments, facts, rule.tools),
        call.span,
        rule.framework,
      );
      llm.tools.push(...tools.ids);
      llm.unresolvedTools += tools.unresolved;
    }
    llm.tools.push(...(this.boundThrough(call) ?? []));
    if (call.receiver !== undefined)
      llm.tools.push(...(this.#bindingsByAssignment.get(call.receiver) ?? []));
    llm.tools = [...new Set(llm.tools)];

    const inputs: DynamicPart[] = [];
    for (const path of rule.user ?? []) {
      for (const value of select(call.arguments, facts, path))
        inputs.push(...d.prompts.inputs(value, call.scope));
    }
    if (rule.keywordInputs) {
      for (const arg of call.arguments)
        if (arg.keyword !== null) inputs.push(...d.prompts.inputs(arg.value, call.scope));
    }
    llm.inputs = uniqueParts(inputs);
    d.inventory.llmCalls.push(llm);
  }

  /**
   * The tools of the `bind_tools()` call a chained call goes through
   * (`model.bind_tools(t).invoke()`), found as the first call that starts at the same position.
   */
  boundThrough(call: CallFact): string[] | undefined {
    const facts = this.#d.facts;
    const bound = callsStartingAt(facts, call.span).find(
      (index) => facts.calls[index] !== call && this.#bindingsByCall.has(index),
    );
    return bound === undefined ? undefined : this.#bindingsByCall.get(bound);
  }

  toolBinding(rule: ToolBindingRule, call: CallFact, index: number): void {
    const d = this.#d;
    const tools = d.tools.toolsFrom(
      select(call.arguments, d.facts, rule.tools),
      call.span,
      rule.framework,
    );
    this.#bindingsByCall.set(index, tools.ids);
    const instance = d.instances.instanceOf(call.receiver);
    if (instance?.kind === "agent") {
      // `register_tool` changes the agent itself.
      instance.component.tools = [...new Set([...instance.component.tools, ...tools.ids])];
      instance.component.unresolvedTools += tools.unresolved;
    }
    // `bound = model.bind_tools(tools)`: calls through `bound` use these tools.
    const assignment = d.scope.assignmentOf(index);
    if (assignment !== undefined) this.#bindingsByAssignment.set(assignment, tools.ids);
  }

  graphNode(rule: GraphNodeRule, call: CallFact): void {
    const d = this.#d;
    const { scope, facts } = d;
    const instance = d.instances.instanceOfCall(call) ?? d.instances.soleInstance("agent");
    if (instance?.kind !== "agent") return;
    const agent = instance.component;
    let name = scope.literal(select(call.arguments, facts, rule.name));
    let handlerValue = select(call.arguments, facts, rule.handler)[0];
    if (name === null) {
      // `add_node(fn)` names the node after the function.
      handlerValue = select(call.arguments, facts, rule.name)[0];
    }
    const handlerRef = scope.functionRef(handlerValue);
    name ??=
      (handlerRef === null ? undefined : d.project.definition(handlerRef)?.name) ?? UNNAMED_NODE;
    // Chained `.addNode()` calls are recorded outermost first; keep source order.
    const node = { name, ...scope.handlerFields(handlerRef) };
    this.#nodeOrder.set(node, call.span.endLine * 1e6 + call.span.endColumn);
    agent.nodes.push(node);
    agent.nodes.sort((a, b) => (this.#nodeOrder.get(a) ?? 0) - (this.#nodeOrder.get(b) ?? 0));
    const target = handlerValue === undefined ? undefined : deref(handlerValue, facts);
    const bound = target?.kind === "call" ? this.#bindingsByCall.get(target.call) : undefined;
    if (bound !== undefined) agent.tools = [...new Set([...agent.tools, ...bound])];
  }

  /** A call matching an agent rule's run pattern runs the instance it was made on, or the file's agent from that rule. */
  invocation(rule: AgentRule, call: CallFact, index: number): void {
    const d = this.#d;
    const instance = d.instances.instanceOfCall(call);
    const agent =
      instance?.kind === "agent"
        ? instance.component
        : d.instances
            .all()
            .filter(
              (candidate): candidate is Extract<Instance, { kind: "agent" }> =>
                candidate.kind === "agent" && candidate.rule === rule,
            )
            .at(-1)?.component;
    if (agent !== undefined) this.addInvocation(agent, call, index, rule.input);
  }

  /** `Runner.run(agent, input)`: the agent is an argument, not the receiver. */
  agentRun(rule: AgentRunRule, call: CallFact, index: number): void {
    const d = this.#d;
    const [instance] = d.instances.instancesIn(
      select(call.arguments, d.facts, rule.agent),
      "agent",
    );
    if (instance !== undefined) this.addInvocation(instance.component, call, index, rule.input);
  }

  addInvocation(agent: Agent, call: CallFact, index: number, inputPaths: string[] = []): void {
    const d = this.#d;
    let seen = this.#invocations.get(agent);
    if (seen === undefined) {
      seen = new Set();
      this.#invocations.set(agent, seen);
    }
    if (seen.has(index)) return;
    seen.add(index);
    const inputs: DynamicPart[] = [];
    for (const path of inputPaths) {
      for (const value of select(call.arguments, d.facts, path))
        inputs.push(...d.prompts.inputs(value, call.scope));
    }
    agent.invocations.push({ location: d.scope.location(call.span), inputs: uniqueParts(inputs) });
  }

  /** Resolves agent delegates and MCP clients, and attaches decorated tools and prompts. */
  linkAgents(): void {
    const d = this.#d;
    const facts = d.facts;
    for (const { agent, rule, call } of d.agentLinks) {
      if (rule.delegates !== undefined) {
        const delegates = d.instances.instancesIn(
          select(call.arguments, facts, rule.delegates),
          "agent",
        );
        agent.delegates = delegates
          .map((instance) => instance.component.id)
          .filter((id) => id !== agent.id);
      }
      if (rule.mcp !== undefined) {
        const values = select(call.arguments, facts, rule.mcp);
        agent.mcpClients = d.instances
          .instancesIn(values, "mcp_client")
          .map((instance) => instance.component.id);
        // A server the agent runs in its own process: its tools are the agent's.
        for (const { component } of d.instances.instancesIn(values, "mcp_server"))
          agent.tools = [...new Set([...agent.tools, ...component.tools])];
      }
    }
    for (const link of d.receiverLinks) {
      const instance = d.instances.instanceOf(link.receiver);
      if (instance?.kind !== "agent") continue;
      if (link.tool !== undefined) instance.component.tools.push(link.tool.id);
      if (link.prompt !== undefined) {
        instance.component.prompts.push(link.prompt.id);
        link.prompt.usedBy.push(instance.component.id);
      }
    }
  }
}
