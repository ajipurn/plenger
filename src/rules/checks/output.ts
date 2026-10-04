import type { Capability, DynamicPart, Location } from "../../inventory/model.ts";
import { callLabel } from "../../shared/text.ts";
import type { RuleContext } from "../context.ts";
import type { Draft, Severity } from "../model.ts";
import { code, inputList } from "../text.ts";

/** PLG401: model output used as a command, code, query, file path or URL. */
export function outputChecks(cx: RuleContext): Draft[] {
  const drafts: Draft[] = [];
  for (const call of cx.inventory.llmCalls) {
    const label = callLabel(call.target);
    for (const effect of call.outputEffects) {
      const draft = outputDraft(cx, effect, call.target, {
        name: `model call ${code(label)}`,
        location: call.location,
        subject: { kind: "llm_call", name: label, id: call.id },
      });
      if (draft !== null) drafts.push(draft);
    }
  }
  for (const agent of cx.inventory.agents) {
    const name = cx.agentName(agent);
    for (const effect of agent.outputEffects) {
      // Inputs rebound through a helper carry call sites from the caller's file.
      const path = effect.via[0]?.path ?? effect.location.path;
      for (const run of agent.invocations) {
        if (run.location.path !== path) continue;
        const runName = cx.callAt(run.location)?.call.ref?.name;
        if (runName === undefined) continue;
        const draft = outputDraft(cx, effect, runName, {
          name: `agent ${code(name)}`,
          location: run.location,
          subject: { kind: "agent", name, id: agent.id },
        });
        if (draft !== null) drafts.push(draft);
      }
    }
  }
  return drafts;
}

function outputDraft(
  cx: RuleContext,
  effect: Capability,
  source: string,
  origin: { name: string; location: Location; subject: Draft["subject"] },
): Draft | null {
  const site = `${origin.location.line}:${origin.location.column}`;
  const fromModel = (parts: DynamicPart[] | undefined) =>
    (parts ?? []).filter((part) =>
      (part.calls ?? []).some((name, index) => name === source && part.callSites?.[index] === site),
    );
  const inputs = fromModel(effect.inputs);
  const target = code(effect.target);
  let use: { title: string; severity: Severity; effect: string } | null = null;
  switch (effect.kind) {
    case "process":
      if (inputs.length === 0) break;
      use =
        effect.command === "arguments"
          ? {
              title: `is passed as arguments to ${target}`,
              severity: "medium",
              effect: `runs ${target} with ${inputList(inputs)} among its arguments`,
            }
          : {
              title:
                effect.command === "shell"
                  ? "is run as a shell command"
                  : "names the program to run",
              severity: "critical",
              effect: `runs ${inputList(inputs)} with ${target}`,
            };
      break;
    case "code":
      if (inputs.length > 0)
        use = {
          title: `is evaluated as code with ${target}`,
          severity: "critical",
          effect: `evaluates ${inputList(inputs)} with ${target}`,
        };
      break;
    case "database":
      if (effect.query && inputs.length > 0)
        use = {
          title: "is run as a SQL query",
          severity: "high",
          effect: `runs ${inputList(inputs)} with ${target}`,
        };
      break;
    case "file_write":
    case "file_delete":
    case "file_read":
      if (inputs.length > 0)
        use = {
          title: `chooses the file path ${effect.kind === "file_read" ? "read" : effect.kind === "file_write" ? "written" : "deleted"}`,
          severity: effect.kind === "file_read" ? "medium" : "high",
          effect: `uses ${inputList(inputs)} as the path for ${target}`,
        };
      break;
    case "network":
    case "browser": {
      const host = fromModel(effect.host);
      if (host.length > 0)
        use = {
          title: "chooses the URL requested",
          severity: "medium",
          effect: `requests a URL whose host comes from ${inputList(host)} with ${target}`,
        };
      break;
    }
    case "deserialize":
      if (inputs.length > 0)
        use = {
          title: `is deserialized with ${target}`,
          severity: "high",
          effect: `loads ${inputList(inputs)} with ${target}`,
        };
      break;
    case "message":
      if (inputs.length > 0)
        use = {
          title: "chooses the recipient of a message",
          severity: "medium",
          effect: `sends to ${inputList(inputs)} with ${target}`,
        };
      break;
    case "payment":
      if (inputs.length > 0)
        use = {
          title: "sets the amount of a payment",
          severity: "high",
          effect: `pays ${inputList(inputs)} with ${target}`,
        };
      break;
    default:
      break;
  }
  if (use === null) return null;
  const guards = effect.guards ?? [];
  const notes =
    guards.length > 0 ? [`Checks seen on the way: ${guards.map(code).join(", ")}.`] : [];
  const exposedBy =
    origin.subject.id === undefined ? undefined : cx.exposure.get(origin.subject.id);
  if (exposedBy !== undefined) notes.push(`Reachable from ${code(exposedBy)}.`);
  return {
    rule: "PLG401",
    title: `Output of ${origin.name} ${use.title}`,
    severity: use.severity,
    confidence: guards.length > 0 ? "medium" : "high",
    location: effect.location,
    subject: origin.subject,
    evidence: [
      { location: origin.location, message: `${origin.name} produces the output` },
      ...cx.via(effect.via),
      { location: effect.location, message: use.effect },
    ],
    notes,
    exposed: exposedBy !== undefined,
    key: [origin.subject.name, effect.kind, effect.target],
  };
}
