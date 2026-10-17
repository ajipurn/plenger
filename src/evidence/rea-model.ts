/** Import and delivery bounds, shared by the host and dashboard contract. */
export const REA_LIMITS = {
  /** The chosen file; REA's semantic graph, which the import discards, is most of it. */
  fileBytes: 64 * 1024 * 1024,
  requestBytes: 64 * 1024 * 1024 + 8192,
  /** The parts the import reads: everything but the semantic graph and the raw result. */
  readBytes: 16 * 1024 * 1024,
  perScan: 8,
  depth: 32,
  values: 500_000,
  /** Limitations kept per list; the rest are counted in one closing entry. */
  limitations: 256,
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
