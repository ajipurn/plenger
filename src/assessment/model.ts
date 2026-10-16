import type { TokenUsage } from "../redteam/budget.ts";
import { SEVERITIES, type Severity } from "../rules/model.ts";
import { isRecord } from "../shared/guards.ts";

export const STRIDE = [
  "Spoofing",
  "Tampering",
  "Repudiation",
  "Information disclosure",
  "Denial of service",
  "Elevation of privilege",
] as const;
export const ASSESSMENT_LIMITS = {
  contextBytes: 32 * 1024,
  files: 100,
  items: 32,
  evidence: 8,
  text: 2000,
  outputTokens: 4096,
  tokens: 200_000,
  timeoutSeconds: 60,
} as const;

export interface AssessmentEvidence {
  path: string;
  line: number;
}
export interface AssessmentEntity {
  name: string;
  description: string;
  evidence: AssessmentEvidence[];
}
export interface AssessmentThreat {
  category: (typeof STRIDE)[number];
  title: string;
  severity: Severity;
  impact: string;
  mitigation: string;
  evidence: AssessmentEvidence[];
}
export interface AssessmentData {
  status: "completed" | "refused" | "failed";
  reason: string | null;
  summary: string;
  assets: AssessmentEntity[];
  trustBoundaries: AssessmentEntity[];
  threats: AssessmentThreat[];
  limitations: string[];
}
export interface AssessmentReport extends AssessmentData {
  schemaVersion: 1;
  kind: "security-assessment";
  mode: "read-only";
  createdAt: string;
  provider: { name: "anthropic"; model: string; baseUrl: string };
  scope: {
    root: string;
    files: { path: string; lines: number; syntaxErrors: boolean }[];
    scannedFiles: number;
    omittedFiles: number;
    skippedFiles: number;
    partial: boolean;
    contextDigest: string;
  };
  request: { calls: number; usage: TokenUsage | null; accountedTokens: number; durationMs: number };
  /** The exact instructions and request settings; absent on reports written before them. */
  generation?: {
    /** SHA-256 of the instructions, which include the response schema. */
    promptDigest: string;
    /** Null uses the model's default. */
    temperature: number | null;
    /** The saved output ceiling; null follows the model's reported limit. */
    maxOutputTokens: number | null;
  };
}

type Schema = Record<string, unknown>;
function object(properties: Record<string, Schema>, optional: Record<string, Schema> = {}): Schema {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties: { ...properties, ...optional },
  };
}
const text: Schema = { type: "string", minLength: 1, maxLength: ASSESSMENT_LIMITS.text };
const natural: Schema = { type: "integer", minimum: 0 };
function list(items: Schema, maximum: number = ASSESSMENT_LIMITS.items, minimum = 0): Schema {
  return { type: "array", items, maxItems: maximum, minItems: minimum };
}
const evidence = list(
  object({ path: text, line: { type: "integer", minimum: 1 } }),
  ASSESSMENT_LIMITS.evidence,
  1,
);
const properties = {
  status: { enum: ["completed", "refused"] },
  reason: { anyOf: [text, { type: "null" }] },
  summary: text,
  assets: list(object({ name: text, description: text, evidence })),
  trustBoundaries: list(object({ name: text, description: text, evidence })),
  threats: list(
    object({
      category: { enum: STRIDE },
      title: text,
      severity: { enum: SEVERITIES },
      impact: text,
      mitigation: text,
      evidence,
    }),
  ),
  limitations: list(text, ASSESSMENT_LIMITS.items, 1),
};
export const ASSESSMENT_DATA_SCHEMA = object(properties);
export const ASSESSMENT_REPORT_SCHEMA: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Plenger read-only security assessment v1",
  ...object(
    {
      ...properties,
      status: { enum: ["completed", "refused", "failed"] },
      schemaVersion: { const: 1 },
      kind: { const: "security-assessment" },
      mode: { const: "read-only" },
      createdAt: { type: "string", format: "date-time" },
      provider: object({
        name: { const: "anthropic" },
        model: text,
        baseUrl: { type: "string", format: "uri" },
      }),
      scope: object({
        root: text,
        files: list(
          object({ path: text, lines: natural, syntaxErrors: { type: "boolean" } }),
          ASSESSMENT_LIMITS.files,
        ),
        scannedFiles: natural,
        omittedFiles: natural,
        skippedFiles: natural,
        partial: { type: "boolean" },
        contextDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
      }),
      request: object({
        calls: { type: "integer", minimum: 0, maximum: 1 },
        usage: {
          anyOf: [
            object({ inputTokens: natural, outputTokens: natural, additionalTokens: natural }),
            { type: "null" },
          ],
        },
        accountedTokens: natural,
        durationMs: natural,
      }),
    },
    // Optional, so reports written before it still validate against the v1 schema.
    {
      generation: object({
        promptDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        temperature: { anyOf: [{ type: "number", minimum: 0, maximum: 1 }, { type: "null" }] },
        maxOutputTokens: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
      }),
    },
  ),
};

/** Model output cannot choose metadata or cite files outside the submitted context. */
export function parseAssessmentData(
  input: string,
  files: { path: string; lines: number }[],
): AssessmentData {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    throw invalid();
  }
  const value = fields(raw, Object.keys(properties));
  if (value.status !== "completed" && value.status !== "refused") throw invalid();
  const allowed = new Map(files.map((file) => [file.path, file.lines]));
  function citations(value: unknown): AssessmentEvidence[] {
    const result = items(value, ASSESSMENT_LIMITS.evidence).map((value) => {
      const item = fields(value, ["path", "line"]);
      const path = string(item.path);
      if (
        !Number.isSafeInteger(item.line) ||
        (item.line as number) < 1 ||
        (item.line as number) > (allowed.get(path) ?? 0)
      )
        throw new Error("Claude cited evidence outside the submitted file and line scope.");
      return { path, line: item.line as number };
    });
    if (!result.length) throw invalid();
    return result;
  }
  function entities(value: unknown): AssessmentEntity[] {
    return items(value).map((value) => {
      const item = fields(value, ["name", "description", "evidence"]);
      return {
        name: string(item.name),
        description: string(item.description),
        evidence: citations(item.evidence),
      };
    });
  }
  const data: AssessmentData = {
    status: value.status,
    reason: value.reason === null ? null : string(value.reason),
    summary: string(value.summary),
    assets: entities(value.assets),
    trustBoundaries: entities(value.trustBoundaries),
    threats: items(value.threats).map((value) => {
      const item = fields(value, [
        "category",
        "title",
        "severity",
        "impact",
        "mitigation",
        "evidence",
      ]);
      if (
        !STRIDE.includes(item.category as (typeof STRIDE)[number]) ||
        !SEVERITIES.includes(item.severity as Severity)
      )
        throw invalid();
      return {
        category: item.category as (typeof STRIDE)[number],
        title: string(item.title),
        severity: item.severity as Severity,
        impact: string(item.impact),
        mitigation: string(item.mitigation),
        evidence: citations(item.evidence),
      };
    }),
    limitations: items(value.limitations).map(string),
  };
  if (
    !data.limitations.length ||
    (data.status === "completed" && data.reason !== null) ||
    (data.status === "refused" &&
      (!data.reason || data.assets.length || data.trustBoundaries.length || data.threats.length))
  )
    throw invalid();
  return data;
}

function invalid(): Error {
  return new Error("Claude returned an invalid structured assessment.");
}
function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value))
  )
    throw invalid();
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > ASSESSMENT_LIMITS.text)
    throw invalid();
  return value;
}
function items(value: unknown, maximum: number = ASSESSMENT_LIMITS.items): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw invalid();
  return value;
}
