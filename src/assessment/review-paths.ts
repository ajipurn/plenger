import type { Capability, Inventory } from "../inventory/model.ts";
import { SECURITY_REVIEW_LIMITS, type TracedPath } from "./review-model.ts";

/**
 * Every path the static scan traced to an effect, in review order: HTTP and MCP entry
 * points, tools, agents, then model output. Ids follow that order, so they are stable for
 * one scan.
 */
export function tracedPaths(inventory: Inventory): TracedPath[] {
  const paths: Omit<TracedPath, "id">[] = [];
  const effects = (capabilities: readonly Capability[]) => {
    const seen = new Set<string>();
    const list: TracedPath["effects"] = [];
    for (const capability of capabilities) {
      const effect = {
        kind: capability.kind,
        path: capability.location.path,
        line: capability.location.line,
      };
      const key = `${effect.kind}@${effect.path}:${effect.line}`;
      if (seen.has(key) || list.length >= SECURITY_REVIEW_LIMITS.pathEffects) continue;
      seen.add(key);
      list.push(effect);
    }
    return list;
  };
  const at = (location: { path: string; line: number }) => ({
    path: location.path,
    line: location.line,
  });
  for (const entry of inventory.entryPoints)
    if (entry.reaches.length)
      paths.push({
        kind: "entry-point",
        label:
          entry.kind === "mcp"
            ? `MCP ${entry.path ?? "entry point"}`
            : `${entry.method ?? ""} ${entry.path ?? ""}`.trim() || "HTTP entry point",
        at: at(entry.location),
        effects: effects(entry.reaches),
      });
  for (const tool of inventory.tools)
    if (tool.capabilities.length)
      paths.push({
        kind: "tool",
        label: tool.name,
        at: at(tool.location),
        effects: effects(tool.capabilities),
      });
  for (const agent of inventory.agents) {
    const reached = [...agent.capabilities, ...agent.outputEffects];
    if (reached.length)
      paths.push({
        kind: "agent",
        label: agent.name ?? agent.target,
        at: at(agent.location),
        effects: effects(reached),
      });
  }
  for (const call of inventory.llmCalls)
    if (call.outputEffects.length)
      paths.push({
        kind: "model-output",
        label: call.target,
        at: at(call.location),
        effects: effects(call.outputEffects),
      });
  return paths.map((path, index) => ({ id: `path-${index + 1}`, ...path }));
}

/**
 * The paths one review closes: those whose entry is in a file the review received and
 * that no earlier review of the scan received whole, at most `SECURITY_REVIEW_LIMITS.paths`.
 * `received` is null for an exploring review, which can read any allowed file.
 */
export function pathsForReview(
  paths: readonly TracedPath[],
  received: ReadonlySet<string> | null,
  earlier: ReadonlySet<string>,
): { paths: TracedPath[]; left: number } {
  const eligible = paths.filter(
    (path) => !earlier.has(path.at.path) && (received === null || received.has(path.at.path)),
  );
  return {
    paths: eligible.slice(0, SECURITY_REVIEW_LIMITS.paths),
    left: Math.max(0, eligible.length - SECURITY_REVIEW_LIMITS.paths),
  };
}
