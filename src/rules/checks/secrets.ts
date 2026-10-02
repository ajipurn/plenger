import type { Span, Value } from "../../facts/model.ts";
import type { Location } from "../../inventory/model.ts";
import { findSecret } from "../../secrets.ts";
import { clientLabel, code, type RuleContext } from "../context.ts";
import type { Draft } from "../model.ts";

/** PLG501–PLG503: keys and tokens written in code and prompts. */
export function secretChecks(cx: RuleContext): Draft[] {
  const drafts: Draft[] = [];
  const reported = new Set<string>();
  const line = (location: { path: string; line: number }) => `${location.path}:${location.line}`;

  for (const model of cx.inventory.models) {
    if (model.credential !== "literal") continue;
    const client = clientLabel(model.target);
    reported.add(line(model.location));
    drafts.push({
      rule: "PLG501",
      title: `API key for ${code(client)} is written in the code`,
      severity: "high",
      confidence: "high",
      location: model.location,
      subject: { kind: "model", name: client, id: model.id },
      evidence: [
        { location: model.location, message: `${code(client)} created with a literal API key` },
      ],
      notes: ["The key's value is not stored in this report."],
      exposed: false,
      key: [model.target],
    });
  }

  for (const prompt of cx.inventory.prompts) {
    if (prompt.secret === undefined) continue;
    const kind = prompt.secret;
    reported.add(line(prompt.location));
    drafts.push({
      rule: "PLG503",
      title: `Prompt contains a ${kind}`,
      severity: "high",
      confidence: kind === "credential" ? "medium" : "high",
      location: prompt.location,
      subject: { kind: "prompt", name: prompt.role, id: prompt.id },
      evidence: [{ location: prompt.location, message: `${prompt.role} prompt with a ${kind}` }],
      notes: ["The secret's value is not stored in this report."],
      exposed: prompt.usedBy.some((id) => cx.exposure.has(id)),
      key: [prompt.role, kind],
    });
  }

  for (const [path, file] of cx.project.files) {
    const found = new Map<string, { name: string; span: Span; owner: string }>();
    const visit = (value: Value, span: Span, owner: string, depth: number) => {
      if (depth > 6) return;
      switch (value.kind) {
        case "string": {
          const secret = findSecret(value.value);
          const id = `${span.line}|${secret?.name}`;
          if (secret !== null && !found.has(id)) found.set(id, { name: secret.name, span, owner });
          for (const part of value.template ?? []) visit(part, span, owner, depth + 1);
          return;
        }
        case "concat":
          for (const part of value.parts) visit(part, span, owner, depth + 1);
          return;
        case "list":
          for (const item of value.items) visit(item, span, owner, depth + 1);
          return;
        case "object":
          for (const entry of value.entries)
            visit(entry.value, span, entry.key ?? owner, depth + 1);
          return;
        default:
          return;
      }
    };
    for (const assignment of file.facts.assignments)
      visit(assignment.value, assignment.span, assignment.target, 0);
    for (const call of file.facts.calls) {
      for (const arg of call.arguments) visit(arg.value, call.span, arg.keyword ?? call.callee, 0);
    }
    for (const { name, span, owner } of found.values()) {
      const location: Location = { path, ...span };
      if (reported.has(line(location))) continue;
      reported.add(line(location));
      drafts.push({
        rule: "PLG502",
        title: `${name.charAt(0).toUpperCase()}${name.slice(1)} in source code`,
        severity: "high",
        confidence: "high",
        location,
        subject: { kind: "code", name: owner },
        evidence: [{ location, message: `${name} in ${code(owner)}` }],
        notes: ["The secret's value is not stored in this report."],
        exposed: false,
        key: [name, owner],
      });
    }
  }
  return drafts;
}
