import type { Capability, DynamicPart, Tool } from "../../inventory/model.ts";
import { code, inputList, type RuleContext } from "../context.ts";
import type { Confidence, Draft, Severity } from "../model.ts";

/** Built-in SQL tools whose whole purpose is to run the query the model writes. */
const SQL_TOOL = /^QuerySQLData[Bb]aseTool$/;

/** PLG101–PLG108: effects of a tool that take arguments the model chooses. */
export function toolChecks(cx: RuleContext): Draft[] {
  const drafts: Draft[] = [];
  for (const tool of cx.inventory.tools) {
    for (const capability of tool.capabilities) {
      const draft =
        tool.via === "builtin" && capability.target === tool.name
          ? builtinFinding(cx, tool, capability)
          : effectFinding(cx, tool, capability);
      if (draft !== null) drafts.push(draft);
    }
  }
  return drafts;
}

interface Verdict {
  rule: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  /** What the effect does with the input, for the evidence line. */
  effect: string;
  notes?: string[];
}

function effectFinding(cx: RuleContext, tool: Tool, capability: Capability): Draft | null {
  const inputs = cx.modelInputs(tool, capability.inputs);
  const guards = capability.guards ?? [];
  const guarded = guards.length > 0;
  const name = code(tool.name);
  const target = code(capability.target);
  let verdict: Verdict | null = null;
  switch (capability.kind) {
    case "process":
      if (inputs.length === 0) break;
      if (capability.command === "arguments") {
        verdict = {
          rule: "PLG102",
          title: `Tool ${name} passes model input to the arguments of ${target}`,
          severity: "medium",
          confidence: "medium",
          effect: `runs ${target} with ${inputList(inputs)} among its arguments`,
        };
      } else {
        const shell = capability.command === "shell";
        verdict = {
          rule: "PLG101",
          title: shell
            ? `Tool ${name} runs a shell command built from model input`
            : `Tool ${name} runs a program named by model input`,
          severity: "critical",
          confidence: guarded ? "low" : "high",
          effect: shell
            ? `runs ${inputList(inputs)} through a shell with ${target}`
            : `runs ${inputList(inputs)} as the program with ${target}`,
        };
      }
      break;
    case "code":
      if (inputs.length === 0) break;
      verdict = {
        rule: "PLG103",
        title: `Tool ${name} evaluates model input as code with ${target}`,
        severity: "critical",
        confidence: "high",
        effect: `evaluates ${inputList(inputs)} with ${target}`,
      };
      break;
    case "file_read":
    case "file_write":
    case "file_delete": {
      if (inputs.length === 0) break;
      const verb = { file_read: "reads", file_write: "writes", file_delete: "deletes" }[
        capability.kind
      ];
      verdict = {
        rule: "PLG104",
        title: `Tool ${name} ${verb} a file at a path chosen by the model`,
        severity: capability.kind === "file_read" ? "medium" : "high",
        confidence: guarded ? "medium" : "high",
        effect: `${verb} the path ${inputList(inputs)} with ${target}`,
      };
      break;
    }
    case "network":
    case "browser": {
      const host = cx.modelInputs(tool, capability.host);
      if (host.length === 0) break;
      const verb = capability.kind === "browser" ? "opens" : "requests";
      verdict = {
        rule: "PLG105",
        title: `Tool ${name} ${verb} a URL chosen by the model`,
        severity: "medium",
        confidence: guarded ? "medium" : "high",
        effect: `${verb} a URL whose host comes from ${inputList(host)} with ${target}`,
      };
      break;
    }
    case "database":
      if (!capability.query || inputs.length === 0) break;
      verdict = {
        rule: "PLG106",
        title: `Tool ${name} runs a SQL query built from model input`,
        severity: "high",
        confidence: "high",
        effect: `runs a query containing ${inputList(inputs)} with ${target}`,
      };
      break;
    case "deserialize":
      if (inputs.length === 0) break;
      verdict = {
        rule: "PLG107",
        title: `Tool ${name} deserializes model-controlled data with ${target}`,
        severity: "high",
        confidence: "high",
        effect: `loads ${inputList(inputs)} with ${target}`,
      };
      break;
    case "message":
      if (inputs.length === 0) break;
      verdict = {
        rule: "PLG108",
        title: `Tool ${name} sends a message to a recipient chosen by the model`,
        severity: "medium",
        confidence: "medium",
        effect: `sends to ${inputList(inputs)} with ${target}`,
      };
      break;
    case "payment":
      if (inputs.length === 0) break;
      verdict = {
        rule: "PLG108",
        title: `Tool ${name} makes a payment of an amount chosen by the model`,
        severity: "high",
        confidence: "high",
        effect: `pays ${inputList(inputs)} with ${target}`,
      };
      break;
    default:
      break;
  }
  if (verdict === null) return null;
  const notes = verdict.notes ?? [];
  if (guarded) notes.push(`Checks seen on the way: ${guards.map(code).join(", ")}.`);
  return draft(cx, tool, capability, verdict, inputs, notes);
}

/** Built-in tools whose whole purpose is the effect: a shell, a Python REPL, raw SQL. */
function builtinFinding(cx: RuleContext, tool: Tool, capability: Capability): Draft | null {
  const name = code(tool.name);
  let verdict: Verdict | null = null;
  if (capability.hosted) return null;
  if (capability.kind === "process") {
    verdict = {
      rule: "PLG101",
      title: `Tool ${name} lets the model run any shell command`,
      severity: "critical",
      confidence: "high",
      effect: "runs the command the model writes",
    };
  } else if (capability.kind === "code" && capability.sandbox === "none") {
    verdict = {
      rule: "PLG103",
      title: `Tool ${name} runs model-written code on the host`,
      severity: "critical",
      confidence: "high",
      effect: "runs the code the model writes in the application's process",
    };
  } else if (capability.kind === "database" && SQL_TOOL.test(tool.name)) {
    verdict = {
      rule: "PLG106",
      title: `Tool ${name} lets the model run any SQL query`,
      severity: "high",
      confidence: "high",
      effect: "runs the SQL the model writes",
    };
  }
  return verdict === null ? null : draft(cx, tool, capability, verdict, [], []);
}

function draft(
  cx: RuleContext,
  tool: Tool,
  capability: Capability,
  verdict: Verdict,
  inputs: DynamicPart[],
  notes: string[],
): Draft {
  const params = [...new Set(inputs.flatMap((part) => part.from ?? []))].filter((param) =>
    cx.modelParams(tool).has(param),
  );
  const declared =
    params.length > 0
      ? `tool ${code(tool.name)}; the model chooses ${params.map(code).join(", ")}`
      : `tool ${code(tool.name)}`;
  const exposedBy = cx.exposure.get(tool.id);
  if (exposedBy !== undefined) notes.push(`Reachable from ${code(exposedBy)}.`);
  if (tool.approval !== undefined)
    notes.push(`A human approval step was seen: ${code(tool.approval)}.`);
  const sameSite =
    capability.location.path === tool.location.path &&
    capability.location.line === tool.location.line;
  return {
    rule: verdict.rule,
    title: verdict.title,
    severity: verdict.severity,
    confidence: tool.approval !== undefined ? lower(verdict.confidence) : verdict.confidence,
    location: capability.location,
    subject: { kind: "tool", name: tool.name, id: tool.id },
    evidence: sameSite
      ? [{ location: tool.location, message: `${declared}; ${verdict.effect}` }]
      : [
          { location: tool.location, message: declared },
          ...cx.via(capability.via),
          { location: capability.location, message: verdict.effect },
        ],
    notes,
    exposed: exposedBy !== undefined,
    key: [tool.name, capability.target, ...params.sort()],
  };
}

function lower(confidence: Confidence): Confidence {
  return confidence === "high" ? "medium" : "low";
}
