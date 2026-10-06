import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { DefinitionFact, FileFacts, Value } from "../facts/model.ts";
import type { Agent, Location, Tool } from "../inventory/model.ts";
import { type ScannedFile, type ScanResult, scan } from "../scan.ts";
import { compareStrings as compare } from "../shared/compare.ts";
import { isErrno } from "../shared/guards.ts";
import { sha256Hex } from "../shared/hash.ts";
import { VERSION } from "../shared/runtime.ts";
import type { CollectOptions } from "../source/files.ts";

export { formatDiscovery } from "./format.ts";

export interface DiscoveryTarget {
  id: string;
  framework: "llmfy" | "vercel-ai";
  kind: "function" | "factory" | "unresolved" | "route";
  location: Location;
  symbol: string | null;
  async: boolean | null;
  parameters: string[];
  /** A candidate still needs runtime, input/output and test-pack qualification. */
  status: "candidate" | "unsupported";
  reasons: string[];
  agentIds: string[];
  evidence: { kind: "invocation" | "factory-return" | "construction"; location: Location }[];
  /** Built-in test packs checked against the target's tools by observed effect, never by tool name. */
  packs: PackBinding[];
}

export type PackBindingReason =
  | "no-file-write-tool"
  | "file-content-not-written"
  | "file-path-not-model-controlled"
  | "async-tool-handler";

/**
 * Whether a built-in pack's clean task and oracle apply to a target. The file canary
 * needs a synchronous tool whose handler writes model-supplied content to a
 * model-controlled path; the worker's final audit reads the canary files it names.
 */
export interface PackBinding {
  profile: "llmfy-file-canary-v1";
  status: "bound" | "unbound";
  /** Tools that satisfy the pack's contract, by name. */
  tools: string[];
  reasons: PackBindingReason[];
}

/** File APIs that store model-supplied content at a path; directory, rename and mode changes do not. */
const CONTENT_WRITE = /(?:^|\.)(?:write_text|write_bytes|open)$/;

function bindFileCanary(tools: Tool[], files: Map<string, ScannedFile>): PackBinding {
  const bound: string[] = [];
  const reasons = new Set<PackBindingReason>();
  for (const tool of tools) {
    const writes = tool.capabilities.filter((capability) => capability.kind === "file_write");
    if (writes.length === 0) continue;
    const content = writes.filter((capability) => CONTENT_WRITE.test(capability.target));
    if (content.length === 0) {
      reasons.add("file-content-not-written");
      continue;
    }
    if (
      !content.some((capability) =>
        capability.inputs.some((input) => input.source === "param" || input.from?.length),
      )
    ) {
      reasons.add("file-path-not-model-controlled");
      continue;
    }
    const handler = files
      .get(tool.handlerPath ?? tool.location.path)
      ?.facts?.definitions.find((definition) => definition.id === tool.handler);
    if (handler?.async) {
      reasons.add("async-tool-handler");
      continue;
    }
    bound.push(tool.name);
  }
  if (bound.length === 0 && reasons.size === 0) reasons.add("no-file-write-tool");
  return {
    profile: "llmfy-file-canary-v1",
    status: bound.length ? "bound" : "unbound",
    tools: [...new Set(bound)].sort(compare),
    reasons: bound.length ? [] : [...reasons].sort(compare),
  };
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
  /** Static observations from all scanned languages, separate from llmfy runtime candidates. */
  coverage: StaticCoverage;
  requirements: string[];
}

export interface StaticCoverage {
  files: number;
  frameworks: { id: string; name: string }[];
  agentDeclarations: number;
  toolUsingCalls: number;
  httpEntryPoints: {
    framework: string;
    method: string | null;
    path: string | null;
    location: Location;
    toolUsing: boolean;
  }[];
  /** Discovered scope, not a promise that a runtime adapter supports each surface. */
  surfaces?: DiscoveredSurface[];
  incomplete?: boolean;
}

export interface DiscoveredSurface {
  id: string;
  kind: "input" | "tool" | "mcp" | "web" | "retrieval";
  label: string;
  location: Location;
}

function inventorySurfaces(result: ScanResult): DiscoveredSurface[] {
  const surfaces = new Map<string, DiscoveredSurface>();
  function add(
    kind: DiscoveredSurface["kind"],
    identity: string,
    label: string,
    location: Location,
  ) {
    const id = `surface:${sha256Hex(JSON.stringify([kind, location.path, identity]), 24)}`;
    surfaces.set(id, { id, kind, label, location });
  }
  for (const entry of result.inventory.entryPoints) {
    add(
      "input",
      `${entry.handler ?? entry.id}:${entry.method}:${entry.path}`,
      `${entry.method ?? entry.kind.toUpperCase()} ${entry.path ?? entry.handler ?? "entry point"}`,
      entry.location,
    );
    for (const capability of entry.reaches)
      if ((capability.kind === "network" || capability.kind === "browser") && !capability.tool)
        add(
          "web",
          `${entry.handler ?? entry.id}:${capability.target}:${capability.location.line}`,
          `${entry.handler ?? "entry point"} → ${capability.target}`,
          capability.location,
        );
  }
  for (const tool of result.inventory.tools) {
    add("tool", `${tool.handler ?? tool.id}:${tool.name}:${tool.server}`, tool.name, tool.location);
    for (const capability of tool.capabilities)
      if (capability.kind === "network" || capability.kind === "browser")
        add(
          "web",
          `${tool.handler ?? tool.id}:${capability.target}:${capability.location.line}`,
          `${tool.name} → ${capability.target}`,
          capability.location,
        );
  }
  for (const server of result.inventory.mcpServers)
    add("mcp", server.id, server.name ?? `${server.framework} server`, server.location);
  for (const client of result.inventory.mcpClients)
    add("mcp", client.id, `${client.framework} client`, client.location);
  for (const store of result.inventory.dataStores)
    if (store.kind === "retriever" || store.kind === "vector_store")
      add("retrieval", store.id, `${store.kind}: ${store.target}`, store.location);
  for (const agent of result.inventory.agents)
    for (const capability of agent.capabilities)
      if (capability.kind === "network" || capability.kind === "browser")
        if (!capability.tool)
          // Tool-owned effects were already recorded at the tool boundary.
          add(
            "web",
            `${agent.id}:${capability.target}:${capability.location.line}`,
            capability.target,
            capability.location,
          );
  return [...surfaces.values()].sort((a, b) => compare(a.kind, b.kind) || compare(a.id, b.id));
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
    const id = `llmfy:${sha256Hex(JSON.stringify(identity), 16)}`;
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
        packs: [],
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

  for (const target of targets.values()) {
    const toolIds = new Set(
      agents.filter((agent) => target.agentIds.includes(agent.id)).flatMap((agent) => agent.tools),
    );
    target.packs = [
      bindFileCanary(
        result.inventory.tools.filter((tool) => toolIds.has(tool.id)),
        files,
      ),
    ];
  }

  const manifests: DiscoveryReport["manifests"] = [];
  for (const name of ["pyproject.toml", "requirements.txt", "uv.lock", "poetry.lock"]) {
    try {
      const entry = await lstat(join(result.root, name));
      manifests.push({ path: name, status: entry.isFile() ? "present" : "not-a-file" });
    } catch (error) {
      manifests.push({
        path: name,
        status: isErrno(error, "ENOENT") ? "missing" : "unreadable",
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
    coverage: {
      files: result.files.length,
      frameworks: result.inventory.frameworks.map(({ id, name }) => ({ id, name })),
      agentDeclarations: result.inventory.agents.length,
      toolUsingCalls: result.inventory.llmCalls.filter((call) => call.tools.length > 0).length,
      surfaces: inventorySurfaces(result),
      incomplete:
        result.truncated ||
        result.skipped.length > 0 ||
        result.inventory.unrecognised.length > 0 ||
        result.files.some((file) => file.syntaxErrors),
      httpEntryPoints: result.inventory.entryPoints
        .filter((entry) => entry.kind === "http")
        .map((entry) => ({
          framework: entry.framework,
          method: entry.method,
          path: entry.path,
          location: entry.location,
          toolUsing: entry.reaches.some(
            (effect) =>
              effect.kind === "agent" ||
              (effect.kind === "llm" &&
                result.inventory.llmCalls.some(
                  (call) =>
                    call.tools.length > 0 &&
                    call.location.path === effect.location.path &&
                    call.location.line === effect.location.line &&
                    call.location.column === effect.location.column,
                )),
          ),
        })),
    },
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
