import type { Location } from "../inventory/model.ts";

export type Severity = "critical" | "high" | "medium" | "low";
export type Confidence = "high" | "medium" | "low";

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

/** A risk rule: what it looks for and how it maps to OWASP and CWE. */
export interface Rule {
  /** Stable id, e.g. `PLG101`. */
  id: string;
  /** Short kebab-case name, e.g. `tool-command-injection`. */
  name: string;
  /** What the rule finds, as a sentence fragment. */
  title: string;
  description: string;
  /** The highest severity the rule reports; single findings may be rated lower. */
  severity: Severity;
  /**
   * OWASP Top 10 for LLM Applications 2025 (`LLM01:2025`) and OWASP Top 10 for
   * Agentic Applications 2026 (`ASI01`) entries.
   */
  owasp: string[];
  cwe: number[];
  remediation: string;
}

/** One step of the code that supports a finding. */
export interface Evidence {
  location: Location;
  /** What this step shows, in a few words. */
  message: string;
  /** The source line, trimmed and with secrets redacted; added after analysis. */
  snippet?: string;
}

type SubjectKind =
  | "tool"
  | "agent"
  | "llm_call"
  | "entry_point"
  | "mcp_server"
  | "mcp_client"
  | "model"
  | "prompt"
  | "code";

export interface Finding {
  /** Rule id. */
  rule: string;
  /** Stable across unrelated edits: built from the rule, file and subject, not from line numbers. */
  fingerprint: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  /** 0–100 from severity, confidence and exposure; orders the triage list. */
  score: number;
  location: Location;
  snippet?: string;
  subject: { kind: SubjectKind; name: string; id?: string };
  /** The code that supports the finding, from where input enters to where it is used. */
  evidence: Evidence[];
  /** Why it is rated as it is: checks seen, how input was traced, what was not seen. */
  notes: string[];
  /** Reachable from an HTTP route or served by an MCP server over the network. */
  exposed: boolean;
  /**
   * A `plenger-ignore` comment naming this finding's rule, on its line or the line
   * above, with the reason written after the rule ids.
   */
  inline?: { line: number; reason: string };
}

/** What a check returns; the engine adds the fingerprint and score. */
export type Draft = Omit<Finding, "fingerprint" | "score"> & {
  /** Stable parts that tell this finding apart from others of the rule on the same subject. */
  key: string[];
};
