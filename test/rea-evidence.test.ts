import { describe, expect, it } from "vitest";
import { parseReaEvidence, reaPromptContext } from "../src/evidence/import-rea.ts";
import { type ImportedReaEvidence, REA_LIMITS } from "../src/evidence/rea-model.ts";
import { required } from "./support/dashboard.ts";
import { reaEvidence } from "./support/rea.ts";

describe("REA JavaScript evidence import", () => {
  it("retains reported graph provenance and uncertainty while discarding original paths and opaque output", () => {
    const input = { ...reaEvidence(), raw_result: { ignored: "must-not-be-retained" } };
    const before = structuredClone(input);
    const analysis = parseReaEvidence(input);
    expect(analysis.evidenceId).toBe(input.evidence_id);
    expect(analysis.artifact.sha256).toBe(input.subject.digest.sha256);
    expect(analysis.graph.edges[0]?.evidence).toMatchObject({
      state: "inferred",
      authority: "static-relationship-inference",
    });
    expect(analysis.limitations).toContain("Static analysis only.");
    expect(JSON.stringify(analysis)).not.toContain("/private/app");
    expect(JSON.stringify(analysis)).not.toContain("must-not-be-retained");
    expect(input).toEqual(before);
  });

  it("redacts credential fields and recognized secrets before records can be saved", () => {
    const input = reaEvidence();
    const secret = `sk-ant-api03-${"N7aQ2xP4".repeat(6)}`;
    const observation = input.normalized_result.graph.nodes[0]?.observations[0];
    if (!observation) throw new Error("Missing observation.");
    observation.properties = {
      apiKey: "opaque-provider-credential",
      headers: { Authorization: "Bearer opaque-access" },
      code: `client = '${secret}'`,
    };
    const result = JSON.stringify(parseReaEvidence(input));
    for (const value of [secret, "opaque-provider-credential", "opaque-access"])
      expect(result).not.toContain(value);
    expect(result).toContain("<redacted>");
  });

  it.each([
    "wrong operation",
    "digest mismatch",
    "dangling edge",
    "duplicate node",
    "inferred as observed",
    "contradictory coverage",
    "prototype key",
    "excessive depth",
  ])("rejects %s without executing anything", (kind) => {
    const input = reaEvidence();
    const graph = input.normalized_result.graph;
    const firstNode = required(graph.nodes[0], "node");
    const firstObservation = required(firstNode.observations[0], "observation");
    const firstEdge = required(graph.edges[0], "edge");
    if (kind === "wrong operation") input.operation = "capture_process_scenario";
    if (kind === "digest mismatch") input.normalized_result.root_artifact_sha256 = "f".repeat(64);
    if (kind === "dangling edge") firstEdge.target_node_id = `jag_node_${"0".repeat(64)}`;
    if (kind === "duplicate node") graph.nodes.push(structuredClone(firstNode));
    if (kind === "inferred as observed") firstEdge.evidence.state = "observed";
    if (kind === "contradictory coverage") graph.coverage.truncated = true;
    if (kind === "prototype key")
      firstObservation.properties = JSON.parse('{"__proto__":{"polluted":true}}');
    if (kind === "excessive depth") {
      let nested: Record<string, unknown> = {};
      for (let index = 0; index < REA_LIMITS.depth + 1; index++) nested = { nested };
      firstObservation.properties = nested;
    }
    expect(() => parseReaEvidence(input)).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("bounds LLM context and explicitly records omitted graph facts", () => {
    const analysis = parseReaEvidence(reaEvidence());
    const node = required(analysis.graph.nodes[0], "node");
    for (let index = 0; index < 20; index++)
      analysis.graph.nodes.push({ ...node, large: "x".repeat(10_000) });
    const record: ImportedReaEvidence = {
      id: "attachment",
      scanId: "scan",
      filename: "rea.json",
      importedAt: new Date().toISOString(),
      digest: "a".repeat(64),
      verification: "unverified",
      analysis,
    };
    const context = reaPromptContext(record);
    expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(REA_LIMITS.promptBytes);
    expect(context.verification).toBe("unverified");
    expect(context.omittedNodes).toBeGreaterThan(0);
    expect(context.reportedEvidenceId).toBe(analysis.evidenceId);
    expect(context.coverage).toMatchObject({ status: "complete" });
  });
});
