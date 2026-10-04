import type { Capability, Inventory, Location } from "../../../src/inventory/model.ts";
import { capitalize, known, observedList as list, plural } from "../shared/format.ts";

export interface InventoryItem {
  id: string;
  name: string;
  location: Location;
  framework?: string;
  preview: [string, string][];
  toolCount?: number;
  unresolvedTools?: number;
  description?: string | null;
  rows: [string, string][];
  capabilities?: Capability[];
  prompt?: string;
}

export interface InventoryCategory {
  title: string;
  items: InventoryItem[];
}

/** Flatten the scanned inventory into the rows and detail fields the browser renders. */
export function inventoryCategories(inventory: Inventory): InventoryCategory[] {
  const toolNames = new Map(inventory.tools.map((tool) => [tool.id, tool.name]));
  const tools = (ids: string[]) => ids.map((id) => toolNames.get(id) ?? id);
  const toolPreview = (ids: string[], unresolved = 0) => {
    const names = tools(ids);
    const parts = names.slice(0, 2);
    if (names.length > 2) parts.push(`+${names.length - 2} more`);
    if (unresolved > 0) parts.push(`${unresolved} unresolved ${plural(unresolved, "reference")}`);
    return parts.length > 0 ? parts.join(", ") : "None observed";
  };
  return [
    {
      title: "Models",
      items: inventory.models.map((item) => ({
        id: item.id,
        name: item.model ?? item.target,
        location: item.location,
        framework: item.framework,
        preview: [
          [item.model ? "Client" : "Model", item.model ? item.target : "Not resolved"],
          ...(item.baseUrl ? [["Base URL", item.baseUrl] as [string, string]] : []),
        ],
        rows: [
          ["Constructor", item.target],
          ["Model", known(item.model)],
          ["Base URL", known(item.baseUrl)],
          ["Credential source", item.credential],
        ],
      })),
    },
    {
      title: "Agents",
      items: inventory.agents.map((item) => ({
        id: item.id,
        name: item.name ?? item.target,
        location: item.location,
        framework: item.framework,
        preview: [
          ...(item.name ? [["Constructor", item.target] as [string, string]] : []),
          ["Model", known(item.model)],
          ["Tools", toolPreview(item.tools, item.unresolvedTools)],
          ...(item.nodes.length > 0
            ? [["Graph nodes", String(item.nodes.length)] as [string, string]]
            : []),
        ],
        capabilities: item.capabilities,
        toolCount: item.tools.length,
        unresolvedTools: item.unresolvedTools,
        rows: [
          ["Constructor", item.target],
          ["Model", known(item.model)],
          ["Tools", list(tools(item.tools))],
          ["Unresolved tools", String(item.unresolvedTools)],
          ["Approval step", item.approval ?? "Not observed"],
          ["Delegates", list(item.delegates)],
          ["MCP clients", list(item.mcpClients)],
          [
            "Graph nodes",
            list(item.nodes.map((node) => `${node.name}: ${node.handler ?? "not resolved"}`)),
          ],
        ],
      })),
    },
    {
      title: "Tools",
      items: inventory.tools.map((item) => ({
        id: item.id,
        name: item.name,
        location: item.location,
        framework: item.framework,
        description: item.description,
        capabilities: item.capabilities,
        preview: [
          ["Declaration", item.via],
          ["Parameters", list(item.params)],
        ],
        rows: [
          ["Declaration", item.via],
          [
            "Handler",
            item.handler
              ? `${item.handlerPath ? `${item.handlerPath}: ` : ""}${item.handler}`
              : "Not resolved",
          ],
          ["Parameters", list(item.params)],
          ["Approval step", item.approval ?? "Not observed"],
          ["MCP server", known(item.server)],
        ],
      })),
    },
    {
      title: "LLM calls",
      items: inventory.llmCalls.map((item) => ({
        id: item.id,
        name: item.target,
        location: item.location,
        framework: item.framework,
        preview: [["Model", known(item.model)]],
        capabilities: item.outputEffects,
        rows: [
          ["Model", known(item.model)],
          ["Scope", known(item.scope)],
          ["Client", known(item.client)],
          ["Tools", list(tools(item.tools))],
          ["Unresolved tools", String(item.unresolvedTools)],
          ["Prompts", list(item.prompts)],
        ],
      })),
    },
    {
      title: "Entry points",
      items: inventory.entryPoints.map((item) => ({
        id: item.id,
        name:
          item.kind === "http"
            ? `${item.method ?? "*"} ${item.path ?? "Unresolved route"}`
            : `MCP · ${item.handler ?? item.id}`,
        location: item.location,
        framework: item.framework,
        capabilities: item.reaches,
        preview: [
          ["Transport", item.kind],
          ["Handler", known(item.handler)],
        ],
        rows: [
          ["Transport", item.kind],
          [
            "Handler",
            item.handler
              ? `${item.handlerPath ? `${item.handlerPath}: ` : ""}${item.handler}`
              : "Not resolved",
          ],
        ],
      })),
    },
    {
      title: "MCP servers",
      items: inventory.mcpServers.map((item) => ({
        id: item.id,
        name: item.name ?? "Unnamed MCP server",
        toolCount: item.tools.length,
        location: item.location,
        framework: item.framework,
        preview: [
          ["Transport", known(item.transport)],
          ["Tools", toolPreview(item.tools)],
        ],
        rows: [
          ["Transport", known(item.transport)],
          ["Tools", list(tools(item.tools))],
          ["Resources", list(item.resources.map((member) => member.name))],
          ["Prompts", list(item.prompts.map((member) => member.name))],
        ],
      })),
    },
    {
      title: "MCP clients",
      items: inventory.mcpClients.map((item) => ({
        id: item.id,
        name: item.target,
        location: item.location,
        framework: item.framework,
        preview: item.url ? [["URL", item.url]] : [["Command", known(item.command)]],
        rows: [
          ["Command", known(item.command)],
          ["URL", known(item.url)],
        ],
      })),
    },
    {
      title: "Data stores",
      items: inventory.dataStores.map((item) => ({
        id: item.id,
        name: item.target,
        location: item.location,
        framework: item.framework,
        preview: [["Kind", item.kind.replaceAll("_", " ")]],
        rows: [["Kind", item.kind.replaceAll("_", " ")]],
      })),
    },
    {
      title: "Prompts",
      items: inventory.prompts.map((item) => ({
        id: item.id,
        name: `${capitalize(item.role)} prompt`,
        location: item.location,
        prompt: item.text,
        preview: [
          ["Variables", list(item.variables)],
          ["Text", item.truncated ? "Truncated by scanner" : "Captured"],
        ],
        rows: [
          ["Role", item.role],
          ["Template variables", list(item.variables)],
          ["Used by", list(item.usedBy)],
          ["Dynamic expressions", list(item.dynamic.map((part) => part.text))],
          ["Text completeness", item.truncated ? "Truncated by scanner" : "Captured"],
          ["Credential observation", item.secret ?? "None observed"],
        ],
      })),
    },
  ];
}
