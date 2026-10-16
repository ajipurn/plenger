import type { TokenUsage } from "../redteam/budget.ts";
import type { ReviewBilling } from "../redteam/model-pricing.ts";
import { SEVERITIES, type Severity } from "../rules/model.ts";
import { isRecord } from "../shared/guards.ts";
import { STRIDE } from "./model.ts";

/** Shared by the host and browser. A review is explicit and bounded. */
export const SECURITY_REVIEW_LIMITS = {
  contextBytes: 20 * 1024,
  candidateBytes: 16 * 1024,
  responseBytes: 32 * 1024,
  fileBytes: 16 * 1024,
  files: 24,
  /** Imports and callers of cited files that the second review reads besides the batch. */
  relatedBytes: 12 * 1024,
  relatedFiles: 8,
  findings: 6,
  evidence: 6,
  snippetLines: 13,
  text: 1200,
  outputTokens: 8192,
  tokens: 400_000,
  timeoutMs: 120_000,
  perScan: 12,
  calls: 2,
} as const;

export interface ReviewCitation {
  path: string;
  line: number;
  endLine: number;
  role: "source" | "flow" | "sink" | "guard";
  message: string;
}
export interface ReviewCandidate {
  title: string;
  severity: Severity;
  confidence: "high" | "medium" | "low";
  category: (typeof STRIDE)[number];
  description: string;
  impact: string;
  preconditions: string[];
  mitigation: string;
  evidence: ReviewCitation[];
}
export interface ReviewFinding extends ReviewCandidate {
  id: string;
  validation: "source-supported" | "needs-review" | "dismissed";
  validationReason: string;
  evidence: (ReviewCitation & { snippet: string })[];
}
export interface ReviewDiscovery {
  status: "completed" | "refused";
  reason: string | null;
  summary: string;
  architecture: string;
  assets: string[];
  trustBoundaries: string[];
  stride: StrideAssessment[];
  findings: ReviewCandidate[];
  limitations: string[];
}
export interface StrideAssessment {
  category: (typeof STRIDE)[number];
  status: "identified" | "not-observed" | "insufficient-context";
  analysis: string;
  mitigation: string;
  evidence: ReviewCitation[];
}
/** Inclusive source lines. */
export interface ReviewRange {
  line: number;
  endLine: number;
}
export interface ReviewSourceFile {
  path: string;
  /** Lines in the captured file. */
  lines: number;
  digest: string;
  /** Present when only selected functions were submitted: the submitted lines, in order. */
  ranges?: ReviewRange[];
}
/** A file the second review read besides the batch, and how it relates to a cited file. */
export interface RelatedSourceFile extends ReviewSourceFile {
  relation: "imported" | "caller";
  /** The cited file that imports it, or that it calls. */
  via: string;
}
export interface SecurityReview extends Omit<ReviewDiscovery, "status" | "findings"> {
  schemaVersion: 1;
  id: string;
  scanId: string;
  createdAt: string;
  kind: "ai-security-review";
  status: "completed" | "refused" | "failed" | "cancelled";
  provider: { id: string; name: string; model: string };
  /** The connection that ran the second review, when it was not `provider`. */
  validator?: { id: string; name: string; model: string };
  scope: {
    capturedAt: string;
    files: ReviewSourceFile[];
    eligibleFiles: number;
    omittedFiles: number;
    excludedEntries: number;
    partial: boolean;
    contextDigest: string;
    /** Imports and callers of cited files given to the second review only. */
    related?: RelatedSourceFile[];
  };
  request: {
    calls: number;
    usage: TokenUsage | null;
    durationMs: number;
    /** Claude usage and cost of the discovery connection, and of the second review without a validator. */
    billing?: ReviewBilling;
    /** Claude usage and cost of a separate second-review connection. */
    validatorBilling?: ReviewBilling;
  };
  findings: ReviewFinding[];
}

const REVIEW_STATES = ["completed", "refused"] as const;
const CONFIDENCES = ["high", "medium", "low"] as const;
const STRIDE_STATES = ["identified", "not-observed", "insufficient-context"] as const;
const VERDICTS = ["source-supported", "needs-review", "dismissed"] as const;
const CITATION_ROLES = ["source", "flow", "sink", "guard"] as const;
type Schema = Record<string, unknown>;
const text: Schema = { type: "string", minLength: 1, maxLength: SECURITY_REVIEW_LIMITS.text };
const reviewReason: Schema = {
  anyOf: [text, { type: "null" }],
  description:
    "Top-level refusal reason. Use null when status is completed and non-empty text when status is refused. Put candidate explanations in each decision's reason.",
};
function object(properties: Record<string, Schema>): Schema {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}
function list(items: Schema, maximum: number, minimum = 0): Schema {
  return { type: "array", items, minItems: minimum, maxItems: maximum };
}
const candidateProperties = {
  title: text,
  severity: { enum: SEVERITIES },
  confidence: { enum: CONFIDENCES },
  category: { enum: STRIDE },
  description: text,
  impact: text,
  preconditions: list(text, 4),
  mitigation: text,
  evidence: list(
    object({
      path: {
        ...text,
        description: "Copy a submitted source path exactly, including case. Never invent a path.",
      },
      line: { type: "integer", minimum: 1 },
      endLine: {
        type: "integer",
        minimum: 1,
        description:
          "Inclusive end line. Must be at or after line and within the submitted file. For an excerpt, line through endLine must stay inside one submitted range. Prefer focused ranges that support the claim.",
      },
      role: { enum: CITATION_ROLES },
      message: text,
    }),
    SECURITY_REVIEW_LIMITS.evidence,
    1,
  ),
};
const discoveryProperties = {
  status: { enum: REVIEW_STATES },
  reason: reviewReason,
  summary: text,
  architecture: text,
  assets: list(text, 8),
  trustBoundaries: list(text, 8),
  stride: list(
    object({
      category: { enum: STRIDE },
      status: { enum: STRIDE_STATES },
      analysis: text,
      mitigation: text,
      evidence: { ...candidateProperties.evidence, minItems: 0 },
    }),
    STRIDE.length,
  ),
  findings: list(object(candidateProperties), SECURITY_REVIEW_LIMITS.findings),
  limitations: list(text, 8, 1),
};
export const REVIEW_DISCOVERY_SCHEMA = object(discoveryProperties);
export const REVIEW_VALIDATION_SCHEMA = object({
  status: { enum: REVIEW_STATES },
  reason: reviewReason,
  decisions: list(
    object({
      id: text,
      verdict: { enum: VERDICTS },
      reason: text,
    }),
    SECURITY_REVIEW_LIMITS.findings,
  ),
});

/** Canonicalize enums and completed-review reasons. Paths and host-assigned ids remain exact. */
export function parseReviewDiscovery(content: string, files: ReviewSourceFile[]): ReviewDiscovery {
  const data = fields(parse(content), Object.keys(discoveryProperties), "$");
  const status = state(data);
  const scope = new Map(files.map((file) => [file.path, file]));
  const findings = array(data.findings, SECURITY_REVIEW_LIMITS.findings, "$.findings").map(
    (value, index) => {
      const location = `$.findings[${index}]`;
      const item = fields(value, Object.keys(candidateProperties), location);
      const evidence = citations(item.evidence, scope, `${location}.evidence`);
      if (!evidence.length)
        throw invalid(`${location}.evidence`, "at least one source citation is required");
      return {
        title: string(item.title, `${location}.title`),
        severity: enumValue(item.severity, SEVERITIES, `${location}.severity`),
        confidence: enumValue(item.confidence, CONFIDENCES, `${location}.confidence`),
        category: enumValue(item.category, STRIDE, `${location}.category`),
        description: string(item.description, `${location}.description`),
        impact: string(item.impact, `${location}.impact`),
        mitigation: string(item.mitigation, `${location}.mitigation`),
        preconditions: array(item.preconditions, 4, `${location}.preconditions`).map(
          (value, index) => string(value, `${location}.preconditions[${index}]`),
        ),
        evidence,
      };
    },
  );
  if (
    new TextEncoder().encode(JSON.stringify(findings)).byteLength >
    SECURITY_REVIEW_LIMITS.candidateBytes
  )
    throw invalid("$.findings", "candidate evidence exceeds the review size limit");
  const categories = new Set<string>(STRIDE);
  const stride = array(data.stride, STRIDE.length, "$.stride").map(
    (value, index): StrideAssessment => {
      const location = `$.stride[${index}]`;
      const item = fields(
        value,
        ["category", "status", "analysis", "mitigation", "evidence"],
        location,
      );
      const category = enumValue(item.category, STRIDE, `${location}.category`);
      if (!categories.delete(category))
        throw invalid(`${location}.category`, "duplicate STRIDE category");
      const entryStatus = enumValue(item.status, STRIDE_STATES, `${location}.status`);
      const evidence = citations(item.evidence, scope, `${location}.evidence`);
      if (entryStatus === "identified" && !evidence.length)
        throw invalid(
          `${location}.evidence`,
          "an identified threat requires a submitted source citation",
        );
      return {
        category,
        status: entryStatus,
        analysis: string(item.analysis, `${location}.analysis`),
        mitigation: string(item.mitigation, `${location}.mitigation`),
        evidence,
      };
    },
  );
  if (status === "completed" ? categories.size > 0 : stride.length > 0)
    throw invalid(
      "$.stride",
      status === "completed"
        ? "all six STRIDE categories are required exactly once"
        : "a refusal must have an empty STRIDE array",
    );
  const limitations = array(data.limitations, 8, "$.limitations").map((value, index) =>
    string(value, `$.limitations[${index}]`),
  );
  if (!limitations.length) throw invalid("$.limitations", "at least one limitation is required");
  if (status === "refused" && findings.length)
    throw invalid("$.findings", "a refusal must have no findings");
  return {
    status,
    reason: status === "refused" ? string(data.reason, "$.reason") : null,
    summary: string(data.summary, "$.summary"),
    architecture: string(data.architecture, "$.architecture"),
    assets: array(data.assets, 8, "$.assets").map((value, index) =>
      string(value, `$.assets[${index}]`),
    ),
    trustBoundaries: array(data.trustBoundaries, 8, "$.trustBoundaries").map((value, index) =>
      string(value, `$.trustBoundaries[${index}]`),
    ),
    stride: stride.sort((a, b) => STRIDE.indexOf(a.category) - STRIDE.indexOf(b.category)),
    findings,
    limitations,
  };
}

export function parseReviewValidation(
  content: string,
  ids: string[],
): {
  status: "completed" | "refused";
  reason: string | null;
  decisions: { id: string; verdict: ReviewFinding["validation"]; reason: string }[];
} {
  const value = fields(parse(content), ["status", "reason", "decisions"], "$");
  const status = state(value);
  const remaining = new Set(ids);
  const decisions = array(value.decisions, SECURITY_REVIEW_LIMITS.findings, "$.decisions").map(
    (value, index) => {
      const location = `$.decisions[${index}]`;
      const decision = fields(value, ["id", "verdict", "reason"], location);
      const id = string(decision.id, `${location}.id`);
      if (!remaining.delete(id))
        throw invalid(`${location}.id`, "unknown or duplicate host-assigned candidate id");
      return {
        id,
        verdict: enumValue(decision.verdict, VERDICTS, `${location}.verdict`),
        reason: string(decision.reason, `${location}.reason`),
      };
    },
  );
  if (status === "completed" ? remaining.size > 0 : decisions.length > 0)
    throw invalid(
      "$.decisions",
      status === "completed"
        ? "a decision is required for every candidate id"
        : "a refusal must have no decisions",
    );
  return {
    status,
    reason: status === "refused" ? string(value.reason, "$.reason") : null,
    decisions,
  };
}

export class ReviewResponseError extends Error {}
/** Field locations and explanations are host-generated. Never echo rejected model values. */
function invalid(field: string, detail: string): ReviewResponseError {
  return new ReviewResponseError(`Invalid security review at ${field}: ${detail}.`);
}
function citations(
  value: unknown,
  scope: Map<string, ReviewSourceFile>,
  location: string,
): ReviewCitation[] {
  return array(value, SECURITY_REVIEW_LIMITS.evidence, location).map((value, index) => {
    const field = `${location}[${index}]`;
    const cite = fields(value, ["path", "line", "endLine", "role", "message"], field);
    const path = string(cite.path, `${field}.path`);
    const file = scope.get(path);
    if (file === undefined)
      throw invalid(`${field}.path`, "the file was not submitted in this source batch");
    const line = cite.line as number;
    const endLine = cite.endLine as number;
    if (!Number.isSafeInteger(line) || line < 1 || line > file.lines)
      throw invalid(`${field}.line`, "start line must be an integer within the submitted file");
    if (!Number.isSafeInteger(endLine) || endLine < line || endLine > file.lines)
      throw invalid(
        `${field}.endLine`,
        "end line must be an integer at or after the start, within the submitted file",
      );
    if (file.ranges && !file.ranges.some((range) => range.line <= line && endLine <= range.endLine))
      throw invalid(`${field}.line`, "cited lines must stay inside one submitted excerpt range");
    return {
      path,
      line,
      endLine,
      role: enumValue(cite.role, CITATION_ROLES, `${field}.role`),
      message: string(cite.message, `${field}.message`),
    };
  });
}
function parse(content: string): unknown {
  if (new TextEncoder().encode(content).byteLength > SECURITY_REVIEW_LIMITS.responseBytes)
    throw invalid("$", "response exceeds the review size limit");
  try {
    return JSON.parse(content);
  } catch {
    throw invalid("$", "expected one complete JSON object without surrounding text");
  }
}
function fields(value: unknown, keys: string[], location: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(location, "expected an object");
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing) throw invalid(`${location}.${missing}`, "required field is missing");
  if (Object.keys(value).length !== keys.length)
    throw invalid(location, "unexpected fields are not allowed");
  return value;
}
function string(value: unknown, location: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > SECURITY_REVIEW_LIMITS.text)
    throw invalid(
      location,
      `expected non-empty text of at most ${SECURITY_REVIEW_LIMITS.text} characters`,
    );
  return value.trim();
}
function enumValue<T extends string>(value: unknown, allowed: readonly T[], location: string): T {
  const canonical =
    typeof value === "string"
      ? allowed.find((item) => item.toLowerCase() === value.trim().toLowerCase())
      : undefined;
  if (canonical === undefined) throw invalid(location, "unknown enum value");
  return canonical;
}
function array(value: unknown, maximum: number, location: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw invalid(location, `expected an array with at most ${maximum} items`);
  return value;
}
function state(value: Record<string, unknown>): "completed" | "refused" {
  const status = enumValue(value.status, REVIEW_STATES, "$.status");
  if (status === "completed") {
    // Completed reviews normalize incidental provider text to null in both parsers.
    if (
      value.reason !== null &&
      (typeof value.reason !== "string" || value.reason.length > SECURITY_REVIEW_LIMITS.text)
    )
      throw invalid(
        "$.reason",
        `expected null or text of at most ${SECURITY_REVIEW_LIMITS.text} characters`,
      );
  } else string(value.reason, "$.reason");
  return status;
}
