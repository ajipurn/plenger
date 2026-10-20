import { functionId, type PublicFunction } from "../../capabilities/library.ts";
import type { Capability, DynamicPart } from "../../inventory/model.ts";
import { locationKey } from "../../shared/location.ts";
import type { RuleContext } from "../context.ts";
import type { Confidence, Draft, Severity } from "../model.ts";
import { code, inputList, listed } from "../text.ts";

/** Calls that import a module by name rather than evaluate code. */
const DYNAMIC_IMPORT = /(?:^|[.#])(?:import_module|__import__|run_module)$/;
const CONFIDENCE_RANK: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };

interface Verdict {
  rule: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  effect: string;
  /** Why the confidence is what it is. */
  note: string;
}

/** How a public function's parameters reach an effect. */
interface Reach {
  /** The parts of the effect's decisive input that come from the parameters. */
  inputs: DynamicPart[];
  /** Those parameters. */
  params: string[];
  /** Of those, the ones the effect does not receive whole (see `Capability.given`). */
  built: string[];
  /** A parameter is the whole value, or the start of a path or URL. */
  given: boolean;
}

/**
 * PLG901–PLG907, library scans only: parameters of a public function or method that
 * reach a command, a file path, SQL text, the host of a URL, code, a template or a
 * deserializer. Whether callers pass untrusted values is outside the scan, so confidence
 * is at most medium. A path or URL whose start the caller passes is the caller's choice
 * and is not reported; a command, code, SQL, a template or data received whole is, at
 * low confidence. Each effect is reported once, from the function that reaches it with
 * the most confidence and the fewest calls.
 */
export function libraryChecks(cx: RuleContext): Draft[] {
  const best = new Map<string, { draft: Draft; rank: number }>();
  for (const fn of cx.functions) {
    const params = new Set(fn.params);
    const fromParams = (part: DynamicPart) => part.from?.some((name) => params.has(name)) === true;
    const paramsOf = (parts: DynamicPart[]) =>
      [...new Set(parts.flatMap((part) => part.from ?? []))]
        .filter((name) => params.has(name))
        .sort();
    for (const capability of fn.reaches) {
      if (capability.hosted) continue;
      // For a request, only the inputs that decide the URL's host make it a forgery.
      const decisive =
        capability.kind === "network" || capability.kind === "browser"
          ? (capability.host ?? [])
          : capability.inputs;
      const inputs = decisive.filter(fromParams);
      if (inputs.length === 0) continue;
      const given = new Set(paramsOf(capability.given ?? []));
      const traced = paramsOf(inputs);
      const reach: Reach = {
        inputs,
        params: traced,
        built: traced.filter((name) => !given.has(name)),
        given: given.size > 0,
      };
      const names = (capability.program ?? []).some(fromParams);
      const verdict = verdictFor(fn, capability, reach, names);
      if (verdict === null) continue;
      const draft = libraryDraft(cx, fn, capability, verdict, traced);
      const rank = CONFIDENCE_RANK[verdict.confidence] * 100 - capability.via.length;
      const key = `${verdict.rule}|${locationKey(capability.location)}`;
      const kept = best.get(key);
      if (kept === undefined || rank > kept.rank) best.set(key, { draft, rank });
    }
  }
  return [...best.values()].map((item) => item.draft);
}

function verdictFor(
  fn: PublicFunction,
  capability: Capability,
  reach: Reach,
  namesProgram: boolean,
): Verdict | null {
  const guarded = (capability.guards ?? []).length > 0;
  const target = code(capability.target);
  const name = code(fn.definition);
  const inputs = inputList(reach.inputs);
  const whole = reach.built.length === 0;
  // The caller passes a whole command, code, query or data: running it is the function's purpose.
  const confidence: Confidence = whole || guarded ? "low" : "medium";
  const note = whole
    ? `The function receives it whole as ${listed(reach.params.map(code))}, so running it is what the function is for; callers decide whether it is trusted.`
    : `${listed(reach.built.map(code))} is built into it or read from inside a parameter, so a caller may not expect it to reach ${target}.`;
  // A path or URL is reported only on a base the function chooses itself, or read from inside a parameter.
  const located = `${listed(reach.params.map(code))} is read from inside a parameter or placed on a base the function chooses, not a path or URL whose start the caller passes.`;
  switch (capability.kind) {
    case "process":
      if (capability.command === "shell")
        return {
          rule: "PLG901",
          title: whole
            ? `${name} runs its parameter as a shell command`
            : `${name} runs a shell command built from its parameters`,
          severity: "critical",
          confidence,
          effect: `runs ${inputs} through a shell with ${target}`,
          note,
        };
      if (capability.command === "program" && namesProgram)
        return {
          rule: "PLG901",
          title: `${name} runs a program its parameter names`,
          severity: "high",
          confidence: "low",
          effect: `runs ${inputs} as the program with ${target}`,
          note,
        };
      return {
        rule: "PLG901",
        title: `${name} passes its parameters to the arguments of ${target}`,
        severity: "medium",
        confidence: "low",
        effect: `runs ${target} with ${inputs} among its arguments`,
        note,
      };
    case "file_read":
    case "file_write":
    case "file_delete": {
      if (reach.given) return null;
      const verb = { file_read: "reads", file_write: "writes", file_delete: "deletes" }[
        capability.kind
      ];
      return {
        rule: "PLG902",
        title: `${name} ${verb} a file at a path built from its parameters`,
        severity: "high",
        confidence: "low",
        effect: `${verb} the path ${inputs} with ${target}`,
        note: located,
      };
    }
    case "database":
      if (!capability.query) return null;
      return {
        rule: "PLG903",
        title: whole
          ? `${name} runs its parameter as SQL`
          : `${name} runs SQL text built from its parameters`,
        severity: "high",
        confidence,
        effect: `runs a query containing ${inputs} with ${target}`,
        note,
      };
    case "network":
    case "browser": {
      if (reach.given) return null;
      const verb = capability.kind === "browser" ? "opens" : "requests";
      return {
        rule: "PLG904",
        title: `${name} ${verb} a URL whose host comes from inside its parameters`,
        severity: "high",
        confidence: "low",
        effect: `${verb} a URL whose host comes from ${inputs} with ${target}`,
        note: located,
      };
    }
    case "code":
      if (capability.sandbox !== undefined && capability.sandbox !== "none") return null;
      if (DYNAMIC_IMPORT.test(capability.target))
        return {
          rule: "PLG905",
          title: `${name} imports a module its parameter names with ${target}`,
          severity: "high",
          confidence: "low",
          effect: `imports ${inputs} with ${target}`,
          note,
        };
      return capability.template
        ? {
            rule: "PLG906",
            title: whole
              ? `${name} compiles its parameter as a template with ${target}`
              : `${name} compiles a template built from its parameters with ${target}`,
            severity: "critical",
            confidence,
            effect: `compiles ${inputs} as a template with ${target}`,
            note,
          }
        : {
            rule: "PLG905",
            title: whole
              ? `${name} evaluates its parameter as code with ${target}`
              : `${name} evaluates code built from its parameters with ${target}`,
            severity: "critical",
            confidence,
            effect: `evaluates ${inputs} with ${target}`,
            note,
          };
    case "deserialize":
      return {
        rule: "PLG907",
        title: whole
          ? `${name} deserializes its parameter with ${target}`
          : `${name} deserializes data built from its parameters with ${target}`,
        severity: "high",
        confidence,
        effect: `loads ${inputs} with ${target}`,
        note,
      };
    default:
      return null;
  }
}

function libraryDraft(
  cx: RuleContext,
  fn: PublicFunction,
  capability: Capability,
  verdict: Verdict,
  traced: string[],
): Draft {
  const notes = [
    `Library scan: the parameters of public functions count as untrusted input. Parameters traced: ${listed(traced.map(code))}.`,
    verdict.note,
  ];
  const guards = capability.guards ?? [];
  if (guards.length > 0) notes.push(`Checks seen on the way: ${guards.map(code).join(", ")}.`);
  return {
    rule: verdict.rule,
    title: verdict.title,
    severity: verdict.severity,
    confidence: verdict.confidence,
    location: capability.location,
    subject: { kind: "function", name: fn.definition, id: functionId(fn) },
    evidence: [
      { location: fn.location, message: `public function ${code(fn.definition)}` },
      ...cx.via(capability.via),
      { location: capability.location, message: verdict.effect },
    ],
    notes,
    exposed: false,
    key: [fn.definition, capability.target, ...traced],
  };
}
