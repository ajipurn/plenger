import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { DefinitionFact, FileFacts, Value } from "../facts/model.ts";
import type { CollectOptions } from "../files.ts";
import type { Agent, Location } from "../inventory/model.ts";
import { type ScannedFile, type ScanResult, scan } from "../scan.ts";
import { VERSION } from "../version.ts";

export interface DiscoveryTarget {
  id: string;
  framework: "llmfy";
  kind: "function" | "factory" | "unresolved";
  location: Location;
  symbol: string | null;
  async: boolean | null;
  parameters: string[];
  /** A candidate still needs runtime, input/output and test-pack qualification. */
  status: "candidate" | "unsupported";
  reasons: string[];
  agentIds: string[];
  evidence: { kind: "invocation" | "factory-return" | "construction"; location: Location }[];
}

/** Discovery data only: this is deliberately not an executable plan or a run result. */
export interface DiscoveryReport {
  schemaVersion: 1;
  kind: "redteam-discovery";
  tool: { name: "plenger"; version: string };
  root: string;
  mode: "offline";
  executionReady: false;
  targets: DiscoveryTarget[];
  /** Presence only, without reading package scripts, credentials or dependency values. */
  manifests: { path: string; status: "present" | "missing" | "not-a-file" | "unreadable" }[];
  scan: {
    files: number;
    truncated: boolean;
    skipped: ScanResult["skipped"];
    excludedDirs: ScanResult["excludedDirs"];
    syntaxErrors: string[];
  };
  otherFrameworks: string[];
  requirements: string[];
}

/**
 * Discover llmfy invocation sites and directly returned agent factories using the
 * existing static scanner. Never imports Python, starts workers or contacts models.
 */
export async function discoverProject(
  path: string,
  options: CollectOptions = {},
): Promise<DiscoveryReport> {
  const result = await scan(path, { ...options, facts: true });
  const files = new Map(result.files.map((file) => [file.path, file]));
  const agents = result.inventory.agents.filter((agent) => agent.framework === "llmfy");
  const targets = new Map<string, DiscoveryTarget>();

  const add = (
    agent: Agent,
    file: ScannedFile,
    definition: DefinitionFact | undefined,
    kind: DiscoveryTarget["kind"],
    evidence: DiscoveryTarget["evidence"][number],
  ) => {
    const identity = [file.path, definition?.id ?? agent.id, kind];
    const id = `llmfy:${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16)}`;
    let target = targets.get(id);
    if (target === undefined) {
      const reasons: string[] = [];
      if (definition === undefined) reasons.push("no-callable-entry-point");
      else {
        if (definition.kind !== "function" || definition.parent !== null)
          reasons.push("not-a-module-function");
        if (!definition.exported) reasons.push("not-a-public-function");
        if (definition.decorators.length > 0) reasons.push("decorated-function");
        if (definition.name !== definition.id) reasons.push("ambiguous-symbol");
        if (kind === "factory" && definition.params.length !== 0)
          reasons.push("factory-needs-arguments");
        if (kind === "function" && definition.params.length !== 1)
          reasons.push("input-mapping-required");
      }
      if (file.syntaxErrors) reasons.push("source-has-syntax-errors");
      target = {
        id,
        framework: "llmfy",
        kind,
        location: { path: file.path, ...(definition?.span ?? evidence.location) },
        symbol: definition?.name ?? null,
        async: definition?.async ?? null,
        parameters: definition?.params ?? [],
        status: reasons.length === 0 ? "candidate" : "unsupported",
        reasons,
        agentIds: [],
        evidence: [],
      };
      targets.set(id, target);
    }
    const source = files.get(agent.location.path);
    if (
      source?.syntaxErrors &&
      source !== file &&
      !target.reasons.includes("agent-has-syntax-errors")
    ) {
      target.status = "unsupported";
      target.reasons.push("agent-has-syntax-errors");
    }
    if (!target.agentIds.includes(agent.id)) target.agentIds.push(agent.id);
    if (!target.evidence.some((item) => JSON.stringify(item) === JSON.stringify(evidence)))
      target.evidence.push(evidence);
    return target;
  };

  for (const agent of agents) {
    for (const invocation of agent.invocations) {
      const file = files.get(invocation.location.path);
      if (file?.facts === undefined) continue;
      const call = file.facts.calls.find(
        (call) =>
          call.span.line === invocation.location.line &&
          call.span.column === invocation.location.column,
      );
      const definition = file.facts.definitions.find((item) => item.id === call?.scope);
      add(agent, file, definition, definition ? "function" : "unresolved", {
        kind: "invocation",
        location: invocation.location,
      });
    }
  }

  for (const file of result.files) {
    if (file.language !== "python" || file.facts === undefined) continue;
    const facts = file.facts;
    const localAgents = agents.filter((agent) => agent.location.path === file.path);
    for (const definition of facts.definitions) {
      if (definition.kind !== "function") continue;
      const returns = (definition.returns ?? []).map((value) =>
        returnedAgent(value, facts, localAgents),
      );
      for (const agent of returns) {
        if (agent === undefined) continue;
        const target = add(agent, file, definition, "factory", {
          kind: "factory-return",
          location: { path: file.path, ...definition.span },
        });
        if (
          returns.some((item) => item?.id !== agent.id) &&
          !target.reasons.includes("ambiguous-factory-return")
        ) {
          target.status = "unsupported";
          target.reasons.push("ambiguous-factory-return");
        }
      }
    }
  }

  for (const agent of agents) {
    if ([...targets.values()].some((target) => target.agentIds.includes(agent.id))) continue;
    const file = files.get(agent.location.path);
    if (file !== undefined)
      add(agent, file, undefined, "unresolved", {
        kind: "construction",
        location: agent.location,
      });
  }

  const manifests: DiscoveryReport["manifests"] = [];
  for (const name of ["pyproject.toml", "requirements.txt", "uv.lock", "poetry.lock"]) {
    try {
      const entry = await lstat(join(result.root, name));
      manifests.push({ path: name, status: entry.isFile() ? "present" : "not-a-file" });
    } catch (error) {
      manifests.push({
        path: name,
        status:
          error instanceof Error && "code" in error && error.code === "ENOENT"
            ? "missing"
            : "unreadable",
      });
    }
  }

  return {
    schemaVersion: 1,
    kind: "redteam-discovery",
    tool: { name: "plenger", version: VERSION },
    root: result.root,
    mode: "offline",
    executionReady: false,
    targets: [...targets.values()].sort(
      (a, b) =>
        compare(a.location.path, b.location.path) ||
        a.location.line - b.location.line ||
        compare(a.kind, b.kind),
    ),
    manifests,
    scan: {
      files: result.files.length,
      truncated: result.truncated,
      skipped: result.skipped,
      excludedDirs: result.excludedDirs,
      syntaxErrors: result.files.filter((file) => file.syntaxErrors).map((file) => file.path),
    },
    otherFrameworks: result.inventory.frameworks
      .filter((item) => item.id !== "llmfy")
      .map((item) => item.id)
      .sort(compare),
    requirements: [
      "Runtime execution is not implemented; discovery is not a runnable test plan.",
      "Qualify framework/dependency versions and isolation before importing project code.",
      "Verify input/output mappings, test-pack compatibility and observation hooks.",
      "Select model access and enforce run-wide budgets before live tests.",
      "Manifest presence and candidate signatures do not establish runtime compatibility.",
    ],
  };
}

function returnedAgent(
  value: Value,
  facts: FileFacts,
  agents: Agent[],
  depth = 0,
): Agent | undefined {
  if (depth > 12) return undefined;
  if (
    value.kind === "name" &&
    /^[A-Za-z_]\w*$/.test(value.text) &&
    value.assignment !== undefined
  ) {
    const assigned = facts.assignments[value.assignment]?.value;
    return assigned ? returnedAgent(assigned, facts, agents, depth + 1) : undefined;
  }
  if (value.kind !== "call") return undefined;
  const call = facts.calls[value.call];
  if (call === undefined) return undefined;
  const constructed = agents.find(
    (agent) => agent.location.line === call.span.line && agent.location.column === call.span.column,
  );
  if (constructed !== undefined) return constructed;
  if (call.receiver !== undefined) {
    const receiver = facts.assignments[call.receiver]?.value;
    const agent = receiver ? returnedAgent(receiver, facts, agents, depth + 1) : undefined;
    if (agent && call.ref?.name === `${agent.target}().build`) return agent;
  }
  return undefined;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function formatDiscovery(report: DiscoveryReport): string {
  const lines = [
    `plenger ${VERSION} · offline red-team discovery`,
    report.root,
    "",
    "No project code was imported or executed. No model was contacted.",
    "Candidates require qualification; dynamic execution is not available yet.",
    "",
  ];
  if (report.targets.length === 0) lines.push("No llmfy targets discovered.");
  for (const target of report.targets) {
    lines.push(
      `${target.status}  ${target.kind}  ${target.symbol ?? "(unresolved)"}  ${target.location.path}:${target.location.line}`,
      `  ${target.id}`,
    );
    if (target.reasons.length) lines.push(`  ${target.reasons.join(", ")}`);
  }
  lines.push("", "Root dependency manifests (presence only):");
  for (const item of report.manifests) lines.push(`  ${item.path}: ${item.status}`);
  if (report.otherFrameworks.length)
    lines.push("", `Other detected frameworks: ${report.otherFrameworks.join(", ")}`);
  lines.push(
    "",
    `${report.scan.files} files scanned; ${report.scan.skipped.length} skipped; ${report.scan.syntaxErrors.length} with syntax errors.`,
  );
  if (report.scan.truncated)
    lines.push("Discovery is incomplete: the scan file limit was reached.");
  for (const item of report.scan.skipped) lines.push(`  skipped ${item.path}: ${item.reason}`);
  lines.push("", "Before execution:", ...report.requirements.map((item) => `  ${item}`));
  return `${lines.join("\n")}\n`;
}
