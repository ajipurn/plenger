import type { Inventory, Location, TraceGaps } from "../inventory/model.ts";
import type { Project } from "../project/project.ts";
import { compareStrings } from "../shared/compare.ts";
import { locationKey } from "../shared/location.ts";
import { RULE_BY_ID } from "./catalog.ts";
import { agentChecks } from "./checks/agents.ts";
import { mcpChecks } from "./checks/mcp.ts";
import { optionChecks } from "./checks/options.ts";
import { outputChecks } from "./checks/output.ts";
import { promptChecks } from "./checks/prompts.ts";
import { routeChecks } from "./checks/routes.ts";
import { secretChecks } from "./checks/secrets.ts";
import { toolChecks } from "./checks/tools.ts";
import { RuleContext } from "./context.ts";
import type { Draft, Evidence, Finding } from "./model.ts";
import { fingerprint, inTests, SEVERITY_RANK, triageScore } from "./scoring.ts";
import { traceGapText } from "./text.ts";

/**
 * PLG401 (model output reaching an effect) and the PLG1xx tool rules can describe the
 * same sink: a tool whose effect takes the model's arguments is already reported as a
 * tool finding, so the output finding at that location is dropped.
 */
const OUTPUT_EFFECT_RULE = "PLG401";
const TOOL_RULE = /^PLG1\d\d$/;

/** Runs every risk rule over the inventory and returns the findings, most urgent first. */
export function evaluateRules(project: Project, inventory: Inventory): Finding[] {
  const cx = new RuleContext(project, inventory);
  const drafts = [
    ...toolChecks(cx),
    ...agentChecks(cx),
    ...promptChecks(cx),
    ...outputChecks(cx),
    ...secretChecks(cx),
    ...mcpChecks(cx),
    ...optionChecks(cx),
    ...routeChecks(cx),
  ];
  for (const draft of drafts) {
    if (!RULE_BY_ID.has(draft.rule)) throw new Error(`finding for unknown rule ${draft.rule}`);
    const note = traceNote(inventory, draft.subject);
    if (note !== null) draft.notes.push(note);
  }
  const toolSinks = new Set(
    drafts
      .filter((draft) => TOOL_RULE.test(draft.rule))
      .map((draft) => locationKey(draft.location)),
  );
  return finalize(
    drafts.filter(
      (draft) => draft.rule !== OUTPUT_EFFECT_RULE || !toolSinks.has(locationKey(draft.location)),
    ),
  );
}

/**
 * Where tracing the subject's handler, or its agent's tools, stopped short: an effect
 * behind those calls would be missing from this finding and from the scan.
 */
function traceNote(inventory: Inventory, subject: Draft["subject"]): string | null {
  const tool = (id: string | undefined) => inventory.tools.find((item) => item.id === id)?.trace;
  const traces =
    subject.kind === "tool"
      ? [tool(subject.id)]
      : subject.kind === "entry_point"
        ? [inventory.entryPoints.find((item) => item.id === subject.id)?.trace]
        : subject.kind === "agent"
          ? (inventory.agents.find((item) => item.id === subject.id)?.tools ?? []).map(tool)
          : [];
  const found = traces.filter((item): item is TraceGaps => item !== undefined);
  if (found.length === 0) return null;
  const gaps = {
    depthLimited: found.reduce((sum, item) => sum + item.depthLimited, 0),
    dynamic: found.reduce((sum, item) => sum + item.dynamic, 0),
  };
  const where = [...new Set(found.flatMap((item) => item.locations).map(locationText))];
  return `Trace incomplete: ${traceGapText(gaps)} not followed (${where.join(", ")}). Effects behind them were not seen.`;
}

function locationText(location: Location): string {
  return `${location.path}:${location.line}`;
}

function finalize(drafts: Draft[]): Finding[] {
  drafts = drafts.map(inTests);
  // Source order first, so that fingerprints of findings with the same key are numbered stably.
  drafts.sort(
    (a, b) =>
      compareStrings(a.location.path, b.location.path) ||
      a.location.line - b.location.line ||
      a.location.column - b.location.column ||
      compareStrings(a.rule, b.rule),
  );
  const counts = new Map<string, number>();
  const findings = drafts.map((draft): Finding => {
    const base = [draft.rule, draft.location.path, draft.subject.kind, ...draft.key].join("\u0000");
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    const { key: _key, ...rest } = draft;
    return {
      ...rest,
      evidence: mergeSameLine(draft.evidence),
      fingerprint: fingerprint(draft, count),
      score: triageScore(draft.severity, draft.confidence, draft.exposed),
    };
  });
  return findings.sort(
    (a, b) =>
      b.score - a.score ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      compareStrings(a.location.path, b.location.path) ||
      a.location.line - b.location.line ||
      compareStrings(a.rule, b.rule),
  );
}

/** Joins consecutive evidence steps on the same line into one. */
function mergeSameLine(evidence: Evidence[]): Evidence[] {
  const merged: Evidence[] = [];
  for (const step of evidence) {
    const last = merged.at(-1);
    if (last?.location.path === step.location.path && last.location.line === step.location.line) {
      if (!last.message.includes(step.message)) last.message = `${last.message}; ${step.message}`;
      continue;
    }
    merged.push({ ...step });
  }
  return merged;
}
