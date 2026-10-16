/** Synthetic, unauthenticated REA JavaScript Evidence using the documented field shapes. */
export function reaEvidence() {
  const sha256 = "1".repeat(64);
  const node = (digit: string) => `jag_node_${digit.repeat(64)}`;
  const coverage = { status: "complete", truncated: false, omitted_count: 0, limits: [] };
  const fact = () => ({
    authority: "static-relationship-inference",
    state: "inferred",
    confidence: "high",
    artifact: { available: true, artifact_id: `art_${sha256}`, sha256 },
    location: { available: true, value: { kind: "artifact-path", path: "js/tools.ts" } },
    extractor: {
      name: "synthetic-fixture",
      version: "1",
      operation: "infer-static-relationship",
      executable_sha256: null,
    },
    coverage: { ...coverage },
    limitations: ["Relationship inferred from static syntax."],
    evidence_ids: [],
  });
  return {
    evidence_id: `ev_${"2".repeat(64)}`,
    subject: {
      name: "Example Electron app",
      digest: { sha256 },
      local_path: "/private/app",
      format: "directory",
      architecture: null,
    },
    provider: {
      id: "rea-javascript-application",
      name: "REA JavaScript application analyzer",
      version: "1",
    },
    analysis_profile: null,
    predicate_type: "rea.javascript-application-analysis",
    operation: "analyze_javascript_application",
    parameters: { format: "directory", integrity_policy: "strict" },
    raw_result: null,
    normalized_result: {
      input_path: "/private/app",
      format: "directory",
      root_artifact_sha256: sha256,
      inventory_manifest_id: `agm_${"3".repeat(64)}`,
      inventory_graph_sha256: "4".repeat(64),
      integrity_contradictions: [],
      summary: {
        browser_windows: 1,
        preload_entrypoints: 1,
        context_bridge_apis: 1,
        ipc: { operations: 2, main_handlers: 1 },
      },
      statistics: { relevant_files: 3, parsed_javascript_files: 3, modules: 3, parse_failures: 0 },
      graph: {
        schema: "JavaScriptApplicationGraph",
        graph_id: `jag_${"5".repeat(64)}`,
        root_node_ids: [node("6")],
        nodes: ["6", "7"].map((digit, index) => ({
          node_id: node(digit),
          kind: index ? "ipc-handler" : "electron-preload",
          identity: {
            strategy: "canonical-path",
            stability: "artifact-version",
            artifact_sha256: sha256,
            path: index ? "main.js" : "preload.js",
          },
          observations: [
            {
              observation_id: `jag_observation_${digit.repeat(64)}`,
              identifier_strategy: {
                strategy: "semantic-content-sha256",
                stability: "observation-exact",
              },
              label: index ? "shell IPC handler" : "preload bridge",
              source_map_reference: null,
              properties: {} as Record<string, unknown>,
              evidence: fact(),
            },
          ],
        })),
        edges: [
          {
            edge_id: `jag_edge_${"8".repeat(64)}`,
            source_node_id: node("6"),
            target_node_id: node("7"),
            relation: "invokes",
            properties: {},
            evidence: fact(),
            identifier_strategy: {
              strategy: "semantic-content-sha256",
              stability: "relationship-exact",
            },
          },
        ],
        coverage: { ...coverage },
        limitations: ["No runtime behavior was observed."],
      },
      limitations: ["Static analysis only."],
    },
    confidence: "derived",
    authority: "shipped-artifact",
    environment: null,
    limitations: ["No vulnerability validation performed."],
    relationship_coverage: null,
    locations: [{ kind: "artifact-path", path: "artifact-root" }],
    evidence_links: [],
  };
}
