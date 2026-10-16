/** Import and delivery bounds, shared by the host and dashboard contract. */
export const REA_LIMITS = {
  fileBytes: 2 * 1024 * 1024,
  requestBytes: 2 * 1024 * 1024 + 8192,
  perScan: 8,
  depth: 32,
  values: 100_000,
  text: 32_768,
  nodes: 5000,
  edges: 10_000,
  promptBytes: 8192,
} as const;

export type ReaJson = string | number | boolean | null | ReaJson[] | ReaObject;
export interface ReaObject {
  [key: string]: ReaJson;
}

export interface ReaAnalysis {
  evidenceId: string;
  provider: { id: string; name: string; version: string | null };
  artifact: { name: string; format: "directory" | "asar"; sha256: string };
  confidence: "observed" | "derived" | "inferred";
  authority: string;
  summary: ReaObject;
  statistics: ReaObject;
  graph: ReaObject & {
    graph_id: string;
    nodes: ReaObject[];
    edges: ReaObject[];
    coverage: ReaObject;
  };
  limitations: string[];
}

/** A redacted projection, associated by the user with exactly one saved scan. */
export interface ImportedReaEvidence {
  id: string;
  scanId: string;
  filename: string;
  importedAt: string;
  digest: string;
  verification: "unverified";
  analysis: ReaAnalysis;
}
