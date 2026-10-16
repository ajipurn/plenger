import type { Capability, Inventory, Location } from "../inventory/model.ts";
import type { Finding } from "../rules/index.ts";

/** Where the static scan saw a file take part in the project's AI or HTTP surface. */
export interface ReviewFocus {
  /** On a traced path from an entry point, tool or model output to an effect, or in a static finding. */
  traced: boolean;
  /** Lines the scan located: entry points, call steps, effects, components and finding evidence. */
  lines: Set<number>;
  /** Definition ids of handlers (`EntryPoint.handler`, `Tool.handler`). */
  definitions: Set<string>;
}

/**
 * Review focus per file, in review order. Files on paths from HTTP and MCP entry points
 * to effects come first, then tool paths, model output paths and static finding evidence,
 * then the rest of the AI inventory. Each path's files are adjacent, so one source batch
 * tends to hold a path from end to end.
 */
export function reviewFocus(
  inventory: Inventory,
  findings: readonly Finding[],
): Map<string, ReviewFocus> {
  const focus = new Map<string, ReviewFocus>();
  let traced = true;
  const at = (path: string): ReviewFocus => {
    let entry = focus.get(path);
    if (entry === undefined) {
      entry = { traced, lines: new Set(), definitions: new Set() };
      focus.set(path, entry);
    }
    return entry;
  };
  const mark = (location: Location) => at(location.path).lines.add(location.line);
  const handler = (path: string, id: string | null) => {
    if (id !== null) at(path).definitions.add(id);
  };
  const trace = (capabilities: readonly Capability[]) => {
    // Effects whose main argument is not constant first: those are the input-to-sink paths.
    const ordered = [...capabilities].sort(
      (a, b) => Number(b.inputs.length > 0) - Number(a.inputs.length > 0),
    );
    for (const capability of ordered) {
      for (const step of capability.via) mark(step);
      mark(capability.location);
    }
  };

  for (const entry of inventory.entryPoints)
    if (entry.reaches.length) {
      mark(entry.location);
      handler(entry.handlerPath ?? entry.location.path, entry.handler);
      trace(entry.reaches);
    }
  for (const tool of inventory.tools)
    if (tool.capabilities.length) {
      mark(tool.location);
      handler(tool.handlerPath ?? tool.location.path, tool.handler);
      trace(tool.capabilities);
    }
  for (const agent of inventory.agents)
    if (agent.capabilities.length || agent.outputEffects.length) {
      mark(agent.location);
      trace(agent.capabilities);
      trace(agent.outputEffects);
    }
  for (const call of inventory.llmCalls)
    if (call.outputEffects.length) {
      mark(call.location);
      trace(call.outputEffects);
    }
  for (const finding of findings) {
    mark(finding.location);
    for (const step of finding.evidence) mark(step.location);
  }

  traced = false;
  for (const entry of inventory.entryPoints) {
    mark(entry.location);
    handler(entry.handlerPath ?? entry.location.path, entry.handler);
  }
  for (const tool of inventory.tools) {
    mark(tool.location);
    handler(tool.handlerPath ?? tool.location.path, tool.handler);
  }
  for (const agent of inventory.agents) {
    mark(agent.location);
    for (const node of agent.nodes) handler(node.handlerPath ?? agent.location.path, node.handler);
  }
  for (const server of inventory.mcpServers) {
    mark(server.location);
    for (const member of [...server.resources, ...server.prompts]) {
      mark(member.location);
      handler(member.handlerPath ?? member.location.path, member.handler);
    }
  }
  for (const item of [
    ...inventory.mcpClients,
    ...inventory.llmCalls,
    ...inventory.prompts,
    ...inventory.dataStores,
    ...inventory.models,
  ])
    mark(item.location);
  return focus;
}
