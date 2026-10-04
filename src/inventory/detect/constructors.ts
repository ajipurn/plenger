/** Rules that construct components: models, agents, tools, MCP servers and clients, data stores and prompts. */

import {
  ANONYMOUS,
  type CallFact,
  type Decorator,
  type DefinitionFact,
  type Value,
} from "../../facts/model.ts";
import { credentialOf, deref, environmentValue, select, urlString } from "../../facts/query.ts";
import { shortName } from "../../shared/text.ts";
import type {
  AgentRule,
  DetectorRule,
  McpClientRule,
  ModelRule,
  ToolBuiltinRule,
  ToolClassRule,
  ToolDecoratorRule,
  ToolFactoryRule,
} from "../detectors.ts";
import type { Agent, McpClient, McpServer, Model } from "../model.ts";
import type { FileDetector } from "./file-detector.ts";
import { withoutReceiver } from "./tools.ts";

export function model(d: FileDetector, rule: ModelRule, call: CallFact, index: number): void {
  const { scope, facts } = d;
  const component: Model = {
    id: scope.id("model", call.span),
    framework: rule.framework,
    location: scope.location(call.span),
    target: call.ref?.name ?? call.callee,
    model: rule.model === undefined ? null : d.modelName(select(call.arguments, facts, rule.model)),
    baseUrl:
      rule.baseUrl === undefined
        ? null
        : scope.firstOf(
            select(call.arguments, facts, rule.baseUrl),
            (value) => urlString(value, facts) ?? environmentValue(value, facts),
          ),
    credential:
      rule.apiKey === undefined
        ? "default"
        : credentialOf(select(call.arguments, facts, rule.apiKey), facts),
  };
  d.inventory.models.push(component);
  d.instances.register(index, { kind: "model", component, rule });
}

export function agent(d: FileDetector, rule: AgentRule, call: CallFact, index: number): void {
  const { scope, facts } = d;
  const component: Agent = {
    id: scope.id("agent", call.span),
    framework: rule.framework,
    location: scope.location(call.span),
    target: call.ref?.name ?? call.callee,
    name: rule.name === undefined ? null : scope.literal(select(call.arguments, facts, rule.name)),
    model: rule.model === undefined ? null : d.modelName(select(call.arguments, facts, rule.model)),
    tools: [],
    unresolvedTools: 0,
    prompts: [],
    nodes: [],
    delegates: [],
    mcpClients: [],
    invocations: [],
    capabilities: [],
    outputEffects: [],
  };
  const variables =
    rule.variables === undefined
      ? []
      : scope.strings(select(call.arguments, facts, rule.variables));
  for (const path of rule.system ?? []) {
    for (const value of select(call.arguments, facts, path)) {
      const prompt = d.prompts.prompt(
        value,
        "system",
        call,
        component.id,
        variables,
        rule.braces === true,
      );
      if (prompt !== null) component.prompts.push(prompt.id);
    }
  }
  if (rule.tools !== undefined) {
    const tools = d.tools.toolsFrom(
      select(call.arguments, facts, rule.tools),
      call.span,
      rule.framework,
    );
    component.tools.push(...tools.ids);
    component.unresolvedTools += tools.unresolved;
  }
  d.agentLinks.push({ agent: component, rule, call });
  d.inventory.agents.push(component);
  d.instances.register(index, { kind: "agent", component, rule });
}

export function toolDecorator(
  d: FileDetector,
  rule: ToolDecoratorRule,
  definition: DefinitionFact,
  decorator: Decorator,
): void {
  if (d.tools.byHandler(definition.id) !== undefined) return;
  const { scope, facts } = d;
  const explicitName =
    rule.name === undefined ? null : scope.literal(select(decorator.arguments, facts, rule.name));
  const description =
    rule.description === undefined
      ? null
      : scope.literal(select(decorator.arguments, facts, rule.description));
  d.tools.add({
    id: scope.id("tool", definition.span),
    framework: rule.framework,
    location: scope.location(definition.span),
    name: explicitName ?? definition.name ?? ANONYMOUS,
    description: description ?? definition.doc,
    handler: definition.id,
    params: withoutReceiver(definition),
    via: "decorator",
    server: null,
  });
  const tool = d.tools.byHandler(definition.id);
  if (tool !== undefined) d.receiverLinks.push({ receiver: decorator.receiver, tool });
}

export function toolClass(d: FileDetector, rule: ToolClassRule, definition: DefinitionFact): void {
  const { scope } = d;
  const methods = d.facts.definitions.filter(
    (candidate) =>
      candidate.parent === definition.id && rule.methods.includes(candidate.name ?? ""),
  );
  const handler = methods[0] ?? null;
  const tool = d.tools.add({
    id: scope.id("tool", definition.span),
    framework: rule.framework,
    location: scope.location(definition.span),
    name: scope.classAttribute(definition, "name") ?? definition.name ?? ANONYMOUS,
    description: scope.classAttribute(definition, "description") ?? definition.doc,
    handler: handler?.id ?? null,
    params: handler === null ? [] : withoutReceiver(handler),
    via: "class",
    server: null,
  });
  d.tools.registerClass(definition.id, tool);
}

export function toolFactory(
  d: FileDetector,
  rule: ToolFactoryRule,
  call: CallFact,
  index: number,
): void {
  const { scope, facts } = d;
  const handlerRef = scope.functionRef(select(call.arguments, facts, rule.handler)[0]);
  const handler = handlerRef === null ? undefined : d.project.definition(handlerRef);
  const explicitName =
    rule.name === undefined ? null : scope.literal(select(call.arguments, facts, rule.name));
  const assigned = scope.assignedName(index);
  const tool = d.tools.add({
    id: scope.id("tool", call.span),
    framework: rule.framework,
    location: scope.location(call.span),
    name: explicitName ?? assigned ?? handler?.name ?? ANONYMOUS,
    description:
      (rule.description === undefined
        ? null
        : scope.literal(select(call.arguments, facts, rule.description))) ??
      handler?.doc ??
      null,
    ...scope.handlerFields(handlerRef),
    params: handler === undefined ? [] : withoutReceiver(handler),
    via: "factory",
    server: null,
  });
  if (explicitName === null) d.tools.defaultNamed(tool);
  d.tools.registerCall(index, tool);
}

export function toolBuiltin(
  d: FileDetector,
  rule: ToolBuiltinRule,
  call: CallFact,
  index: number,
): void {
  const { scope } = d;
  const target = call.ref?.name ?? call.callee;
  const name =
    (rule.name === undefined ? null : scope.literal(select(call.arguments, d.facts, rule.name))) ??
    shortName(target);
  const tool = d.tools.add({
    id: scope.id("tool", call.span),
    framework: rule.framework,
    location: scope.location(call.span),
    name,
    description: null,
    handler: null,
    params: [],
    via: "builtin",
    server: null,
  });
  d.tools.registerCall(index, tool);
}

export function mcpServer(
  d: FileDetector,
  framework: string,
  call: CallFact,
  index: number,
  namePath: string | undefined,
): void {
  const { scope } = d;
  const server: McpServer = {
    id: scope.id("mcp", call.span),
    framework,
    location: scope.location(call.span),
    name: namePath === undefined ? null : scope.literal(select(call.arguments, d.facts, namePath)),
    transport: null,
    tools: [],
    resources: [],
    prompts: [],
  };
  d.inventory.mcpServers.push(server);
  d.instances.register(index, { kind: "mcp_server", component: server });
}

export function mcpClient(
  d: FileDetector,
  rule: McpClientRule,
  call: CallFact,
  index: number,
): void {
  const { scope, facts } = d;
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
    const command = scope.literal(config.command);
    const client: McpClient = {
      id: scope.id("mcp-client", call.span),
      framework: rule.framework,
      location: scope.location(call.span),
      target: call.ref?.name ?? call.callee,
      command: command === null ? null : [command, ...scope.strings(config.args)].join(" "),
      url: scope.firstOf(config.url, (value) => urlString(value, facts)),
    };
    // `MCPToolset("http://...")` and similar take a URL or a command in one argument.
    if (client.url === null && client.command !== null && /^https?:\/\//.test(client.command)) {
      client.url = client.command;
      client.command = null;
    }
    d.inventory.mcpClients.push(client);
    if (d.instances.constructedBy(index) === undefined) {
      d.instances.register(index, { kind: "mcp_client", component: client });
    }
  }
}

export function dataStore(
  d: FileDetector,
  rule: Extract<DetectorRule, { kind: "data_store" }>,
  call: CallFact,
  name: string,
): void {
  d.inventory.dataStores.push({
    id: d.scope.id("store", call.span),
    framework: rule.framework,
    location: d.scope.location(call.span),
    kind: rule.store,
    target: name,
  });
}

export function promptCall(
  d: FileDetector,
  rule: Extract<DetectorRule, { kind: "prompt" }>,
  call: CallFact,
): void {
  for (const value of select(call.arguments, d.facts, rule.text)) {
    d.prompts.prompt(value, rule.role, call, null, [], rule.braces === true);
  }
}
