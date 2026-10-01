import type { Capability, Inventory, Location } from "../src/inventory/model.ts";

/**
 * A line-per-item form of an inventory, used as the expected-results format for the
 * fixture corpus: each item is one string, so precision and recall are set overlaps.
 */
export type CompactInventory = Record<string, string[]>;

const at = (location: Location) => `${location.path}:${location.line}`;
const ref = (id: string | null) =>
  id === null ? "-" : id.replace(/^([\w-]+):.*:(\d+):\d+(?:#\d+)?$/, "$1@$2");
const text = (value: string | null, width = 40) =>
  value === null ? "-" : JSON.stringify(value.slice(0, width));
const capability = (item: Capability) =>
  `${item.kind}:${item.kind === "agent" ? ref(item.target) : item.target}${item.hosted ? "(hosted)" : ""}` +
  `[${item.inputs.map((input) => `${input.text}:${input.source}`)}]@${at(item.location)}` +
  (item.via.length > 0 ? `<${item.via.map(at).join("<")}` : "");

export function compact(inventory: Inventory): CompactInventory {
  const toolName = new Map(inventory.tools.map((tool) => [tool.id, tool.name]));
  const tools = (ids: string[]) => `[${ids.map((id) => toolName.get(id) ?? id).join(",")}]`;
  return {
    frameworks: inventory.frameworks.map(
      (framework) => `${framework.id} ${[...framework.files].sort().join(",")}`,
    ),
    unrecognised: inventory.unrecognised.map(
      (entry) => `${entry.module} ${[...entry.files].sort().join(",")}`,
    ),
    models: inventory.models.map(
      (model) =>
        `${at(model.location)} ${model.target} model=${model.model ?? "-"} baseUrl=${model.baseUrl ?? "-"} credential=${model.credential}`,
    ),
    llmCalls: inventory.llmCalls.map(
      (call) =>
        `${at(call.location)} ${call.target} model=${call.model ?? "-"} client=${ref(call.client)} tools=${tools(call.tools)}+${call.unresolvedTools} prompts=[${call.prompts.map(ref)}] inputs=[${call.inputs.map((input) => `${input.text}:${input.source}`)}]`,
    ),
    agents: inventory.agents.map(
      (agent) =>
        `${at(agent.location)} ${agent.target} name=${agent.name ?? "-"} model=${agent.model ?? "-"} tools=${tools(agent.tools)}+${agent.unresolvedTools} prompts=[${agent.prompts.map(ref)}] nodes=[${agent.nodes.map((node) => `${node.name}->${node.handler ?? "-"}`)}] delegates=[${agent.delegates.map(ref)}] mcp=[${agent.mcpClients.map(ref)}] runs=[${agent.invocations.map((run) => `${run.location.line}(${run.inputs.map((input) => `${input.text}:${input.source}`)})`)}] capabilities=[${[...new Set(agent.capabilities.map((item) => item.kind))].sort()}]`,
    ),
    tools: inventory.tools.map(
      (tool) =>
        `${at(tool.location)} ${tool.name} via=${tool.via} handler=${tool.handler ?? "-"} params=[${tool.params}] server=${ref(tool.server)} description=${text(tool.description)} capabilities=[${tool.capabilities.map(capability)}]`,
    ),
    mcpServers: inventory.mcpServers.map(
      (server) =>
        `${at(server.location)} ${server.name ?? "-"} transport=${server.transport ?? "-"} tools=${tools(server.tools)} resources=[${server.resources.map((member) => member.name)}] prompts=[${server.prompts.map((member) => member.name)}]`,
    ),
    mcpClients: inventory.mcpClients.map(
      (client) =>
        `${at(client.location)} ${client.target} command=${client.command ?? "-"} url=${client.url ?? "-"}`,
    ),
    prompts: inventory.prompts.map(
      (prompt) =>
        `${at(prompt.location)} ${prompt.role} ${text(prompt.text)} dynamic=[${prompt.dynamic.map((part) => `${part.text}:${part.source}`)}] variables=[${prompt.variables}] usedBy=[${prompt.usedBy.map(ref)}]`,
    ),
    dataStores: inventory.dataStores.map(
      (store) => `${at(store.location)} ${store.kind} ${store.target}`,
    ),
    entryPoints: inventory.entryPoints.map(
      (entry) =>
        `${at(entry.location)} ${entry.framework} ${entry.method ?? "-"} ${entry.path ?? "-"} handler=${entry.handler ?? "-"} reaches=[${entry.reaches.map(capability)}]`,
    ),
  };
}

export interface Score {
  kind: string;
  expected: number;
  found: number;
  matched: number;
  precision: number;
  recall: number;
}

/** Precision and recall per inventory section, matching items exactly. */
export function score(expected: CompactInventory, actual: CompactInventory): Score[] {
  return Object.keys(expected).map((kind) => {
    const want = new Set(expected[kind]);
    const got = actual[kind] ?? [];
    const matched = got.filter((item) => want.has(item)).length;
    return {
      kind,
      expected: want.size,
      found: got.length,
      matched,
      precision: got.length === 0 ? 1 : matched / got.length,
      recall: want.size === 0 ? 1 : matched / want.size,
    };
  });
}
