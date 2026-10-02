import type { FileFacts, Value } from "../../facts/model.ts";
import type { Location } from "../../inventory/model.ts";
import { deref, literalString, select } from "../../inventory/values.ts";
import { clientLabel, code, type RuleContext } from "../context.ts";
import type { Draft, Severity } from "../model.ts";

/** smolagents imports that give generated code the run of the host. */
const DANGEROUS_IMPORTS =
  /^(?:\*|os|subprocess|sys|shutil|socket|builtins|importlib|pickle|ctypes|pty)(?:\.\*)?$/;

interface Option {
  rule: string;
  /** Argument paths (inventory/values.ts `select`) where the option may be set. */
  paths: string[];
  severity: Severity;
  /** What the option does, for the title. */
  effect: string;
}

/** Framework options that switch off a safety default when set to true. */
const OPTIONS: Option[] = [
  {
    rule: "PLG701",
    paths: ["allow_dangerous_code"],
    severity: "high",
    effect: "lets the agent run the code the model writes",
  },
  {
    rule: "PLG702",
    paths: ["allow_dangerous_deserialization"],
    severity: "high",
    effect: "lets the loader unpickle files",
  },
  {
    rule: "PLG703",
    paths: ["trust_remote_code", "model_kwargs.trust_remote_code"],
    severity: "high",
    effect: "runs code shipped with the model or dataset",
  },
  {
    rule: "PLG704",
    paths: ["dangerouslyAllowBrowser"],
    severity: "high",
    effect: "ships the API key to the browser",
  },
  {
    rule: "PLG705",
    paths: ["allow_dangerous_requests", "allowDangerousRequests"],
    severity: "medium",
    effect: "lets request tools call any URL",
  },
];

/** PLG701–PLG705: safety switches turned off in framework calls. */
export function optionChecks(cx: RuleContext): Draft[] {
  const drafts: Draft[] = [];
  for (const [path, file] of cx.project.files) {
    const facts = file.facts;
    const on = (name: string) => (file.language === "python" ? `${name}=True` : `${name}: true`);
    for (const call of facts.calls) {
      const location: Location = { path, ...call.span };
      const callee = call.ref?.name ?? call.callee;
      for (const option of OPTIONS) {
        const set = option.paths.find((candidate) =>
          isTrue(select(call.arguments, facts, candidate)[0], facts),
        );
        if (set === undefined) continue;
        drafts.push(
          optionDraft(option.rule, option.severity, on(set), option.effect, callee, location, cx),
        );
      }
      // smolagents: `additional_authorized_imports=["*"]` or modules that reach the host.
      const imports = select(call.arguments, facts, "additional_authorized_imports")[0];
      const resolved = imports === undefined ? undefined : deref(imports, facts);
      if (resolved?.kind === "list") {
        const dangerous = resolved.items
          .map((item) => literalString(item, facts))
          .filter((item): item is string => item !== null && DANGEROUS_IMPORTS.test(item));
        if (dangerous.length > 0)
          drafts.push(
            optionDraft(
              "PLG701",
              "high",
              `additional_authorized_imports=[${dangerous.map((item) => `"${item}"`).join(", ")}]`,
              "lets generated code import modules that reach the host",
              callee,
              location,
              cx,
            ),
          );
      }
    }
  }
  return drafts;
}

function optionDraft(
  rule: string,
  severity: Severity,
  setting: string,
  effect: string,
  callee: string,
  location: Location,
  cx: RuleContext,
): Draft {
  const short = clientLabel(callee);
  const exposed = cx.inventory.agents.some(
    (agent) => cx.exposure.has(agent.id) && sameCall(agent.location, location),
  );
  return {
    rule,
    title: `${code(setting)} ${effect} (${code(short)})`,
    severity,
    confidence: "high",
    location,
    subject: { kind: "code", name: short },
    evidence: [{ location, message: `${code(short)} called with ${code(setting)}` }],
    notes: [],
    exposed,
    key: [short, setting.replace(/[=:].*$/, "")],
  };
}

function sameCall(a: Location, b: Location): boolean {
  return a.path === b.path && a.line === b.line && a.column === b.column;
}

function isTrue(value: Value | undefined, facts: FileFacts): boolean {
  if (value === undefined) return false;
  const target = deref(value, facts);
  return target.kind === "literal" && /^(?:True|true)$/.test(target.text);
}
