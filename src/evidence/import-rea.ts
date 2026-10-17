import { isRecord } from "../shared/guards.ts";
import { REDACTED, redact } from "../shared/secrets.ts";
import {
  type ImportedReaEvidence,
  REA_LIMITS,
  type ReaAnalysis,
  type ReaJson,
  type ReaObject,
} from "./rea-model.ts";

export class ReaImportError extends Error {}
const digestPattern = /^[a-f0-9]{64}$/;

/** Parse a complete CLI Evidence record. No paths, commands, URLs or modules are opened. */
export function parseReaEvidence(input: unknown): ReaAnalysis {
  // The semantic graph and the raw result are discarded below, so they are not read.
  const read = withoutDiscarded(input);
  checkBounds(read);
  if (Buffer.byteLength(JSON.stringify(read)) > REA_LIMITS.readBytes)
    throw new ReaImportError(
      "The REA result exceeds the import size limit. Export a smaller application analysis.",
    );
  const value = record(read);
  if (
    value.operation !== "analyze_javascript_application" ||
    value.predicate_type !== "rea.javascript-application-analysis"
  )
    throw new ReaImportError("Choose a complete REA analyze-javascript-application JSON result.");
  const provider = record(value.provider);
  if (provider.id !== "rea-javascript-application") throw invalid();
  const subject = record(value.subject);
  const result = record(value.normalized_result);
  const subjectDigest = record(subject.digest).sha256;
  if (
    typeof subjectDigest !== "string" ||
    !digestPattern.test(subjectDigest) ||
    result.root_artifact_sha256 !== subjectDigest ||
    subject.format !== result.format ||
    (result.format !== "directory" && result.format !== "asar")
  )
    throw invalid();
  const graph = record(result.graph);
  if (graph.schema !== "JavaScriptApplicationGraph") throw invalid();
  id(value.evidence_id, "ev");
  id(graph.graph_id, "jag");
  const nodes = objects(graph.nodes, REA_LIMITS.nodes);
  const edges = objects(graph.edges, REA_LIMITS.edges);
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    const nodeId = id(node.node_id, "jag_node");
    if (nodeIds.has(nodeId)) throw invalid();
    nodeIds.add(nodeId);
    text(node.kind);
    for (const observation of objects(node.observations, 100)) {
      if (observation.label !== null) text(observation.label);
      fact(record(observation.evidence));
    }
    if (!Array.isArray(node.observations) || !node.observations.length) throw invalid();
  }
  if (
    !Array.isArray(graph.root_node_ids) ||
    graph.root_node_ids.some((root) => typeof root !== "string" || !nodeIds.has(root))
  )
    throw invalid();
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    const edgeId = id(edge.edge_id, "jag_edge");
    if (
      edgeIds.has(edgeId) ||
      !nodeIds.has(String(edge.source_node_id)) ||
      !nodeIds.has(String(edge.target_node_id))
    )
      throw invalid();
    edgeIds.add(edgeId);
    text(edge.relation);
    fact(record(edge.evidence));
  }
  coverage(record(graph.coverage));
  if (!["observed", "derived", "inferred"].includes(String(value.confidence))) throw invalid();
  const summary = record(result.summary);
  const statistics = record(result.statistics);
  const counts = counters(summary);
  counts.ipc = counters(record(summary.ipc));
  const analysis: ReaAnalysis = {
    evidenceId: String(value.evidence_id),
    provider: {
      id: String(provider.id),
      name: text(provider.name, 128),
      version: provider.version === null ? null : text(provider.version, 64),
    },
    artifact: { name: text(subject.name, 512), format: result.format, sha256: subjectDigest },
    confidence: value.confidence as ReaAnalysis["confidence"],
    authority: text(value.authority, 64),
    summary: counts,
    statistics: counters(statistics),
    graph: {
      schema: "JavaScriptApplicationGraph",
      graph_id: String(graph.graph_id),
      root_node_ids: graph.root_node_ids as string[],
      nodes: nodes as ReaObject[],
      edges: edges as ReaObject[],
      coverage: graph.coverage as ReaObject,
      limitations: strings(graph.limitations),
    },
    limitations: [...new Set([...strings(value.limitations), ...strings(result.limitations)])],
  };
  // Drop the original envelope, raw_result, analysis_profile, parameters, semantic
  // graph and input paths. Redact every retained string and credential-named field.
  return sanitize(analysis as unknown as ReaJson) as unknown as ReaAnalysis;
}

/** The record without the parts the import never keeps. */
function withoutDiscarded(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const { raw_result: _raw, ...rest } = input;
  if (!isRecord(rest.normalized_result)) return rest;
  const { semantic_graph: _semantic, ...result } = rest.normalized_result;
  return { ...rest, normalized_result: result };
}

function checkBounds(value: unknown): void {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item) break;
    if (++visited > REA_LIMITS.values || item.depth > REA_LIMITS.depth)
      throw new ReaImportError(
        "The REA result is too complex. Export a smaller application analysis.",
      );
    if (typeof item.value === "string" && item.value.length > REA_LIMITS.text)
      throw new ReaImportError(
        "The REA result contains text that is too long. Export a smaller application analysis.",
      );
    if (item.value !== null && typeof item.value === "object")
      for (const [key, child] of Object.entries(item.value)) {
        if (key.length > 256 || key === "__proto__") throw invalid();
        pending.push({ value: child, depth: item.depth + 1 });
      }
  }
}

function sanitize(value: ReaJson, key = ""): ReaJson {
  if (
    /^(authorization|cookie|set-cookie|password|passwd|secret|token|credentials?|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)$/i.test(
      key,
    )
  )
    return REDACTED;
  if (/^(local_path|input_path)$/i.test(key)) return "<local path omitted>";
  if (typeof value === "string")
    return /^(?:\/|[A-Za-z]:[\\/]|file:\/\/)/.test(value)
      ? "<absolute path omitted>"
      : redact(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, child]) => [redact(name), sanitize(child, name)]),
    );
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalid();
  return value;
}
function text(value: unknown, maximum: number = REA_LIMITS.text): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0"))
    throw invalid();
  return value;
}
function id(value: unknown, prefix: string): string {
  const result = text(value);
  if (!new RegExp(`^${prefix}_[a-f0-9]{64}$`).test(result)) throw invalid();
  return result;
}
/** A list of texts; a long list keeps the first `REA_LIMITS.limitations` and counts the rest. */
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalid();
  const kept = value.slice(0, REA_LIMITS.limitations).map((item) => text(item));
  const more = value.length - kept.length;
  return more > 0 ? [...kept, `${more} more not kept by the import.`] : kept;
}
function objects(value: unknown, maximum: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > maximum) throw invalid();
  return value.map(record);
}
function counters(value: Record<string, unknown>): ReaObject {
  if (Object.keys(value).length > 32 || Object.keys(value).some((key) => key.length > 64))
    throw invalid();
  const output: ReaObject = {};
  for (const [key, count] of Object.entries(value)) {
    if (key === "ipc") continue;
    if (!Number.isSafeInteger(count) || (count as number) < 0) throw invalid();
    output[key] = count as number;
  }
  return output;
}
function coverage(value: Record<string, unknown>): void {
  if (
    !["complete", "partial", "unknown", "unavailable"].includes(String(value.status)) ||
    typeof value.truncated !== "boolean" ||
    !(
      value.omitted_count === null ||
      (Number.isSafeInteger(value.omitted_count) && (value.omitted_count as number) >= 0)
    )
  )
    throw invalid();
  if (value.status === "complete" && (value.truncated || value.omitted_count !== 0))
    throw invalid();
  if (value.truncated && (value.status !== "partial" || value.omitted_count === 0)) throw invalid();
}
function fact(value: Record<string, unknown>): void {
  if (!["observed", "inferred", "unknown", "unavailable"].includes(String(value.state)))
    throw invalid();
  text(value.authority);
  text(value.confidence);
  if (
    (value.authority === "static-relationship-inference" ||
      value.authority === "cross-layer-reconciliation") &&
    value.state !== "inferred"
  )
    throw invalid();
  coverage(record(value.coverage));
  strings(value.limitations);
}
function invalid(): ReaImportError {
  return new ReaImportError(
    "The REA JSON does not contain a supported complete JavaScript application Evidence record.",
  );
}

/** A bounded projection keeps omissions and imported authority explicit to the model. */
export function reaPromptContext(record: ImportedReaEvidence): ReaObject {
  const { analysis } = record;
  const graph = analysis.graph;
  const context: ReaObject = {
    source: "user-imported-rea",
    verification: "unverified",
    attachmentId: record.id,
    digest: record.digest,
    filename: record.filename,
    reportedEvidenceId: analysis.evidenceId,
    artifact: { ...analysis.artifact },
    provider: { ...analysis.provider },
    reportedConfidence: analysis.confidence,
    reportedAuthority: analysis.authority,
    summary: analysis.summary,
    statistics: analysis.statistics,
    coverage: {
      status: graph.coverage.status ?? "unknown",
      truncated: graph.coverage.truncated ?? false,
      omitted_count: graph.coverage.omitted_count ?? null,
    },
    limitations: [],
    nodes: [],
    edges: [],
    omittedLimitations: analysis.limitations.length + (graph.limitations as string[]).length,
    omittedNodes: graph.nodes.length,
    omittedEdges: graph.edges.length,
  };
  if (Buffer.byteLength(JSON.stringify(context)) > REA_LIMITS.promptBytes)
    throw new ReaImportError(
      "This import's metadata is too large for a fix prompt. Choose a smaller REA analysis.",
    );
  for (const [key, values, omittedKey] of [
    [
      "limitations",
      [...analysis.limitations, ...(graph.limitations as string[])],
      "omittedLimitations",
    ],
    ["nodes", graph.nodes, "omittedNodes"],
    ["edges", graph.edges, "omittedEdges"],
  ] as const) {
    const selected = context[key] as ReaJson[];
    for (const value of values) {
      selected.push(value);
      if (Buffer.byteLength(JSON.stringify(context)) > REA_LIMITS.promptBytes) selected.pop();
      else context[omittedKey] = Number(context[omittedKey]) - 1;
    }
  }
  return context;
}
