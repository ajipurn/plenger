/**
 * Where model output goes: effects whose input is computed from the result of a model
 * call or an agent run, attached to that call or agent as `outputEffects`.
 */

import type {
  Agent,
  Capability,
  CapabilityKind,
  Inventory,
  LlmCall,
  Location,
} from "../inventory/model.ts";
import { MODULE_SCOPE, type ProjectIndex } from "../project/index.ts";
import { locationKey } from "../shared/location.ts";
import type { EffectTracer } from "./effects.ts";

/** Effects that misbehave when their input is model output. */
const OUTPUT_SINKS = new Set<CapabilityKind>([
  "process",
  "code",
  "file_read",
  "file_write",
  "file_delete",
  "network",
  "database",
  "message",
  "payment",
  "deserialize",
  "browser",
]);

interface Site {
  path: string;
  scope: string;
  llms: LlmCall[];
  runs: { agent: Agent; name: string; location: Location }[];
}

/**
 * For every function that calls a model or runs an agent, the effects it reaches
 * (through project functions too) with an input computed from that call's result.
 */
export function attachOutputEffects(
  inventory: Inventory,
  tracer: EffectTracer,
  index: ProjectIndex,
): void {
  const sites = new Map<string, Site>();
  const site = (path: string, scope: string | null) => {
    const id = `${path}|${scope ?? MODULE_SCOPE}`;
    let entry = sites.get(id);
    if (entry === undefined) {
      entry = { path, scope: scope ?? MODULE_SCOPE, llms: [], runs: [] };
      sites.set(id, entry);
    }
    return entry;
  };
  for (const llm of inventory.llmCalls) site(llm.location.path, llm.scope).llms.push(llm);
  for (const agent of inventory.agents) {
    for (const run of agent.invocations) {
      const call = index.callAt(run.location)?.call;
      if (call?.ref?.name !== undefined)
        site(run.location.path, call.scope).runs.push({
          agent,
          name: call.ref.name,
          location: run.location,
        });
    }
  }
  for (const { path, scope, llms, runs } of sites.values()) {
    for (const effect of tracer.effects(path, scope, 0)) {
      if (!OUTPUT_SINKS.has(effect.kind)) continue;
      // `name@line:column` of every call the effect's inputs come from, in this function's file.
      const from = new Set(
        [...effect.inputs, ...(effect.host ?? [])].flatMap((part) =>
          (part.calls ?? []).map((name, index) => `${name}@${part.callSites?.[index]}`),
        ),
      );
      if (from.size === 0) continue;
      const at = (name: string, location: Location) =>
        from.has(`${name}@${location.line}:${location.column}`);
      for (const llm of llms) {
        if (at(llm.target, llm.location) && !llm.outputEffects.some((item) => same(item, effect)))
          llm.outputEffects.push(effect);
      }
      for (const { agent, name, location } of runs) {
        if (at(name, location) && !agent.outputEffects.some((item) => same(item, effect)))
          agent.outputEffects.push(effect);
      }
    }
  }
}

function same(a: Capability, b: Capability): boolean {
  return (
    a.kind === b.kind &&
    a.target === b.target &&
    locationKey(a.location) === locationKey(b.location)
  );
}
