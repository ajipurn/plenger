import { requestObjectOf } from "../../facts/query.ts";
import type { Capability, DynamicPart, EntryPoint } from "../../inventory/model.ts";
import { routeLabel } from "../../shared/text.ts";
import type { RuleContext } from "../context.ts";
import type { Confidence, Draft, Severity } from "../model.ts";
import { code, inputList } from "../text.ts";

/** Handler parameters for the response or the next handler, never request data. */
const RESPONSE_PARAMS = /^(?:res|response|reply|next|background_tasks)$/;

interface Verdict {
  rule: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  effect: string;
}

/**
 * PLG801–PLG807: request input that reaches a command, a file path, SQL text, the host of
 * a URL, code, a template or a deserializer.
 */
export function routeChecks(cx: RuleContext): Draft[] {
  const drafts: Draft[] = [];
  for (const entry of cx.inventory.entryPoints) {
    if (entry.kind !== "http") continue;
    const sources = requestSources(cx, entry);
    for (const capability of entry.reaches) {
      // For a request, only the inputs that decide the URL's host make it a forgery.
      const decisive =
        capability.kind === "network" || capability.kind === "browser"
          ? (capability.host ?? [])
          : capability.inputs;
      const inputs = decisive.filter((part) => part.from?.some(sources) === true);
      if (inputs.length === 0 || capability.hosted) continue;
      const program = (capability.program ?? []).filter((part) => part.from?.some(sources));
      const verdict = verdictFor(routeLabel(entry), capability, inputs, program.length > 0);
      if (verdict !== null) drafts.push(draft(cx, entry, capability, verdict, inputs, sources));
    }
  }
  return drafts;
}

/**
 * What request input is, by the names an input part comes from: a parameter of the
 * handler that the framework fills from the request (not a dependency, the response or
 * a validated FastAPI scalar), or a request global (`flask.request`). A parameter of a
 * function further down that tracing could not bind is neither.
 */
function requestSources(cx: RuleContext, entry: EntryPoint): (name: string) => boolean {
  const facts = cx.project.files.get(entry.handlerPath ?? entry.location.path)?.facts;
  const handler = facts?.definitions.find((definition) => definition.id === entry.handler);
  // FastAPI validates a parameter typed `int`, `UUID` or `date` before the handler runs.
  const excluded = new Set([
    ...(handler?.injected ?? []),
    ...(entry.framework === "fastapi" ? (handler?.scalars ?? []) : []),
  ]);
  const params = new Set(handler?.params ?? []);
  return (name) =>
    (params.has(name) || requestObjectOf(name) === name) &&
    !excluded.has(name) &&
    !RESPONSE_PARAMS.test(name);
}

function verdictFor(
  route: string,
  capability: Capability,
  inputs: DynamicPart[],
  namesProgram: boolean,
): Verdict | null {
  const guarded = (capability.guards ?? []).length > 0;
  const target = code(capability.target);
  const name = code(route);
  switch (capability.kind) {
    case "process":
      // A program the request does not name, run with request input among its arguments.
      if (capability.command === "arguments" || (capability.command === "program" && !namesProgram))
        return {
          rule: "PLG801",
          title: `${name} passes request input to the arguments of ${target}`,
          severity: "medium",
          confidence: "medium",
          effect: `runs ${target} with ${inputList(inputs)} among its arguments`,
        };
      return {
        rule: "PLG801",
        title:
          capability.command === "shell"
            ? `${name} runs a shell command built from request input`
            : `${name} runs a program named by request input`,
        severity: "critical",
        confidence: guarded ? "low" : "high",
        effect:
          capability.command === "shell"
            ? `runs ${inputList(inputs)} through a shell with ${target}`
            : `runs ${inputList(inputs)} as the program with ${target}`,
      };
    case "file_read":
    case "file_write":
    case "file_delete": {
      const verb = { file_read: "reads", file_write: "writes", file_delete: "deletes" }[
        capability.kind
      ];
      return {
        rule: "PLG802",
        title: `${name} ${verb} a file at a path built from request input`,
        severity: "high",
        confidence: guarded ? "medium" : "high",
        effect: `${verb} the path ${inputList(inputs)} with ${target}`,
      };
    }
    case "database":
      if (!capability.query) return null;
      return {
        rule: "PLG803",
        title: `${name} runs a SQL query built from request input`,
        severity: "high",
        confidence: "high",
        effect: `runs a query containing ${inputList(inputs)} with ${target}`,
      };
    case "network":
    case "browser": {
      const verb = capability.kind === "browser" ? "opens" : "requests";
      return {
        rule: "PLG804",
        title: `${name} ${verb} a URL whose host comes from request input`,
        severity: "high",
        confidence: guarded ? "medium" : "high",
        effect: `${verb} a URL whose host comes from ${inputList(inputs)} with ${target}`,
      };
    }
    case "code":
      if (capability.sandbox !== undefined && capability.sandbox !== "none") return null;
      return capability.template
        ? {
            rule: "PLG806",
            title: `${name} renders request input as a template with ${target}`,
            severity: "critical",
            confidence: "high",
            effect: `compiles ${inputList(inputs)} as a template with ${target}`,
          }
        : {
            rule: "PLG805",
            title: `${name} evaluates request input as code with ${target}`,
            severity: "critical",
            confidence: "high",
            effect: `evaluates ${inputList(inputs)} with ${target}`,
          };
    case "deserialize":
      return {
        rule: "PLG807",
        title: `${name} deserializes request input with ${target}`,
        severity: "high",
        confidence: "high",
        effect: `loads ${inputList(inputs)} with ${target}`,
      };
    default:
      return null;
  }
}

function draft(
  cx: RuleContext,
  entry: EntryPoint,
  capability: Capability,
  verdict: Verdict,
  inputs: DynamicPart[],
  sources: (name: string) => boolean,
): Draft {
  const route = routeLabel(entry);
  const params = [...new Set(inputs.flatMap((part) => part.from ?? []))].filter(sources).sort();
  const notes = [`Request input traced: ${params.map(code).join(", ")}.`];
  const guards = capability.guards ?? [];
  if (guards.length > 0) notes.push(`Checks seen on the way: ${guards.map(code).join(", ")}.`);
  return {
    rule: verdict.rule,
    title: verdict.title,
    severity: verdict.severity,
    confidence: verdict.confidence,
    location: capability.location,
    subject: { kind: "entry_point", name: route, id: entry.id },
    evidence: [
      { location: entry.location, message: `route ${code(route)}` },
      ...cx.via(capability.via),
      { location: capability.location, message: verdict.effect },
    ],
    notes,
    exposed: true,
    key: [route, capability.target, ...params],
  };
}
