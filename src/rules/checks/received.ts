import type { Receiver } from "../../capabilities/received.ts";
import type { Capability, DynamicPart } from "../../inventory/model.ts";
import { locationKey } from "../../shared/location.ts";
import type { RuleContext } from "../context.ts";
import type { Draft, Severity } from "../model.ts";
import { code, inputList } from "../text.ts";

interface Verdict {
  rule: string;
  title: string;
  severity: Severity;
  effect: string;
}

/**
 * PLG809–PLG812: data received over the network (an HTTP response, a socket or zmq
 * message, a remote listing) that reaches a command, a file path, code or a deserializer.
 * Whether the remote end is trusted is outside the scan, so confidence is medium. Each
 * effect is reported once per rule.
 */
export function receivedChecks(cx: RuleContext): Draft[] {
  const drafts = new Map<string, Draft>();
  for (const receiver of cx.received) {
    const site = `${receiver.target}@${receiver.location.line}:${receiver.location.column}`;
    const fromReceiver = (part: DynamicPart) =>
      (part.calls ?? []).some((name, at) => `${name}@${part.callSites?.[at]}` === site);
    for (const capability of receiver.effects) {
      if (capability.hosted) continue;
      const inputs = capability.inputs.filter(fromReceiver);
      if (inputs.length === 0) continue;
      const verdict = verdictFor(receiver, capability, inputs, fromReceiver);
      if (verdict === null) continue;
      const key = `${verdict.rule}|${locationKey(capability.location)}`;
      if (!drafts.has(key)) drafts.set(key, draft(cx, receiver, capability, verdict));
    }
  }
  return [...drafts.values()];
}

function verdictFor(
  receiver: Receiver,
  capability: Capability,
  inputs: DynamicPart[],
  fromReceiver: (part: DynamicPart) => boolean,
): Verdict | null {
  const where = code(receiver.scope ?? receiver.location.path);
  const received = `data received with ${code(receiver.target)}`;
  const target = code(capability.target);
  switch (capability.kind) {
    case "process": {
      // Received data among a fixed program's arguments is left out: an option at most.
      const names = (capability.program ?? []).some(fromReceiver);
      if (capability.command !== "shell" && !(capability.command === "program" && names))
        return null;
      return {
        rule: "PLG809",
        title:
          capability.command === "shell"
            ? `${where} runs a shell command built from ${received}`
            : `${where} runs a program named by ${received}`,
        severity: "critical",
        effect: `runs ${inputList(inputs)} with ${target}`,
      };
    }
    case "file_read":
    case "file_write":
    case "file_delete": {
      const verb = { file_read: "reads", file_write: "writes", file_delete: "deletes" }[
        capability.kind
      ];
      return {
        rule: "PLG810",
        title: `${where} ${verb} a file at a path built from ${received}`,
        severity: "high",
        effect: `${verb} the path ${inputList(inputs)} with ${target}`,
      };
    }
    case "code":
      if (capability.sandbox !== undefined && capability.sandbox !== "none") return null;
      return {
        rule: "PLG811",
        title: `${where} evaluates ${received} as code with ${target}`,
        severity: "critical",
        effect: `${capability.template ? "compiles" : "evaluates"} ${inputList(inputs)} with ${target}`,
      };
    case "deserialize":
      return {
        rule: "PLG812",
        title: `${where} deserializes ${received} with ${target}`,
        severity: "high",
        effect: `loads ${inputList(inputs)} with ${target}`,
      };
    default:
      return null;
  }
}

function draft(
  cx: RuleContext,
  receiver: Receiver,
  capability: Capability,
  verdict: Verdict,
): Draft {
  const where = receiver.scope ?? receiver.location.path;
  return {
    rule: verdict.rule,
    title: verdict.title,
    severity: verdict.severity,
    // A check seen on the way may confine the data; plenger does not verify it.
    confidence: (capability.guards ?? []).length > 0 ? "low" : "medium",
    location: capability.location,
    subject: { kind: "code", name: where },
    evidence: [
      { location: receiver.location, message: `receives data with ${code(receiver.target)}` },
      ...cx.via(capability.via),
      { location: capability.location, message: verdict.effect },
    ],
    notes: [
      "Whoever controls the remote end, or the network between, chooses this data. Plenger cannot tell whether that end is trusted.",
      ...((capability.guards ?? []).length > 0
        ? [`Checks seen on the way: ${(capability.guards ?? []).map(code).join(", ")}.`]
        : []),
    ],
    exposed: false,
    key: [where, receiver.target, capability.target],
  };
}
