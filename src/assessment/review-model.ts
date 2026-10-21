import type { TokenUsage } from "../redteam/budget.ts";
import { type ModelPricing, type ReviewBilling, worstCaseCost } from "../redteam/model-pricing.ts";
import { SEVERITIES, type Severity } from "../rules/model.ts";
import { isRecord } from "../shared/guards.ts";
import { STRIDE } from "./model.ts";

/**
 * Shared by the host and browser. A review is explicit and bounded. `contextBytes`,
 * `fileBytes`, `files` and `relatedBytes` are the batch budget when the model's input
 * window is unknown; `reviewBudget` scales them to a known window up to the `max*` values.
 */
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
  /** Lines a dismissal cites: the control or source that decides it. */
  dismissalEvidence: 3,
  /** Traced paths one review is asked to close, and the effects listed for each. */
  paths: 16,
  pathEffects: 6,
  /** Lines a safe closure cites. */
  closureEvidence: 2,
  snippetLines: 13,
  text: 1200,
  outputTokens: 8192,
  tokens: 400_000,
  timeoutMs: 120_000,
  /** Reviews one static scan can hold: the batches of a Full coverage scan. */
  perScan: 100,
  calls: 2,
  /** Largest request a review sends, so a scaled batch fits the provider transport. */
  requestBytes: 256 * 1024,
  /**
   * Instructions, schema, environment notes and candidates a validation request adds,
   * plus the 4,096-token margin providers add to every reservation.
   */
  requestOverheadBytes: 36 * 1024,
  maxContextBytes: 112 * 1024,
  maxFileBytes: 48 * 1024,
  maxFiles: 48,
  maxRelatedBytes: 48 * 1024,
} as const;

/** Bounds of an exploring review's sessions; the evaluation tunes them. */
export const EXPLORE_LIMITS = {
  discovery: {
    modelCalls: 12,
    toolBytes: 160 * 1024,
    requestBytes: 192 * 1024,
    tokens: 1_000_000,
    timeMs: 600_000,
  },
  validation: {
    modelCalls: 6,
    toolBytes: 64 * 1024,
    requestBytes: 128 * 1024,
    tokens: 400_000,
    timeMs: 300_000,
  },
  /** The first set of files in the discovery message, packed as a batch. */
  firstBytes: 48 * 1024,
  /** Cited ranges the second review's first message re-reads. */
  citedBytes: 32 * 1024,
  toolsPerTurn: 8,
  /** Tool calls one reply may hold; those past `toolsPerTurn` are answered with an error. */
  replyToolCalls: 64,
  /**
   * Output tokens per turn. A submission holds the whole review, which can pass a batch
   * reply's 8,192 tokens on a larger project, thinking included.
   */
  outputTokens: 16_384,
  /** Replies cut at the output allowance that a session answers with a request to shorten. */
  cutReplies: 1,
  /** What earlier reviews of a Full coverage scan read and reported, in the first message. */
  earlierBytes: 8 * 1024,
  readLines: 300,
  readBytes: 16 * 1024,
  listEntries: 300,
  searchMatches: 40,
  searchFiles: 2000,
  searchBytes: 32 * 1024 * 1024,
  queryMin: 3,
  queryMax: 200,
  mapBytes: 24 * 1024,
  hintsBytes: 8 * 1024,
} as const;

/** What one batch may submit, and the related bytes its second review may add. */
export interface ReviewBudget {
  contextBytes: number;
  fileBytes: number;
  files: number;
  relatedBytes: number;
  /** The smallest input window of the review's models, or null when one is unknown. */
  inputTokens: number | null;
}

/**
 * The batch budget for the models a review uses. The cost ceiling stays the same: at
 * most `tokens` accounted tokens and `calls` requests per batch. A token covers at least
 * one byte of the request, so the validation request (overhead, batch and related files)
 * is sized to fit half that ceiling and the smallest model window, with 70% for the
 * batch and 30% for related files. An unknown window keeps the default 20 KiB batch.
 */
export function reviewBudget(windows: readonly (number | null | undefined)[]): ReviewBudget {
  const L = SECURITY_REVIEW_LIMITS;
  const known = windows.filter((value): value is number => typeof value === "number" && value > 0);
  if (!known.length || known.length < windows.length)
    return {
      contextBytes: L.contextBytes,
      fileBytes: L.fileBytes,
      files: L.files,
      relatedBytes: L.relatedBytes,
      inputTokens: null,
    };
  const inputTokens = Math.min(...known);
  const request = Math.min(inputTokens, L.tokens / 2) - L.outputTokens - L.requestOverheadBytes;
  const contextBytes = Math.max(4 * 1024, Math.min(L.maxContextBytes, Math.floor(request * 0.7)));
  return {
    contextBytes,
    fileBytes: Math.min(
      contextBytes,
      Math.max(L.fileBytes, Math.min(L.maxFileBytes, contextBytes / 2)),
    ),
    files: Math.max(L.files, Math.min(L.maxFiles, Math.floor(contextBytes / 2048))),
    relatedBytes: Math.max(2 * 1024, Math.min(L.maxRelatedBytes, Math.floor(request * 0.3))),
    inputTokens,
  };
}

/**
 * A spending limit across every connection a review uses: accounted tokens, or USD
 * estimated from saved prices.
 */
export type SpendingLimit = { kind: "tokens"; tokens: number } | { kind: "usd"; usd: number };

/** A request's prompt token bound and output allowance. */
export interface RequestTokenBound {
  prompt: number;
  output: number;
}

/**
 * The most one batch's two requests can reserve, at one token per request byte: the
 * discovery request holds the batch and the instructions; the validation request adds
 * related files and candidates. `requestOverheadBytes` covers the rest and the margin.
 */
export function batchTokenBound(sizes: ReviewBudget): {
  discovery: RequestTokenBound;
  validation: RequestTokenBound;
  total: number;
} {
  const L = SECURITY_REVIEW_LIMITS;
  const discovery = { prompt: sizes.contextBytes + L.requestOverheadBytes, output: L.outputTokens };
  const validation = {
    prompt: sizes.contextBytes + sizes.relatedBytes + L.requestOverheadBytes,
    output: L.outputTokens,
  };
  const total = discovery.prompt + discovery.output + validation.prompt + validation.output;
  return { discovery, validation, total };
}

/** The most one batch can cost in USD at saved prices, with the second review's prices. */
export function batchCostBound(
  sizes: ReviewBudget,
  pricing: ModelPricing,
  validatorPricing: ModelPricing = pricing,
): number {
  const bound = batchTokenBound(sizes);
  return (
    worstCaseCost(pricing, bound.discovery.prompt, bound.discovery.output) +
    worstCaseCost(validatorPricing, bound.validation.prompt, bound.validation.output)
  );
}

/**
 * The most an exploring review can charge: each session's token limit, priced with
 * every allowed output token at the output rate and the rest at the dearest prompt rate.
 */
export function exploreTokenBound(): {
  discovery: RequestTokenBound;
  validation: RequestTokenBound;
  total: number;
} {
  const phase = (limits: { modelCalls: number; tokens: number }) => {
    const output = limits.modelCalls * EXPLORE_LIMITS.outputTokens;
    return { prompt: limits.tokens - output, output };
  };
  const discovery = phase(EXPLORE_LIMITS.discovery);
  const validation = phase(EXPLORE_LIMITS.validation);
  return {
    discovery,
    validation,
    total: EXPLORE_LIMITS.discovery.tokens + EXPLORE_LIMITS.validation.tokens,
  };
}

export function exploreCostBound(
  pricing: ModelPricing,
  validatorPricing: ModelPricing = pricing,
): number {
  const bound = exploreTokenBound();
  return (
    worstCaseCost(pricing, bound.discovery.prompt, bound.discovery.output) +
    worstCaseCost(validatorPricing, bound.validation.prompt, bound.validation.output)
  );
}

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
  /** The CWE that names the weakness (`CWE-89`), or null when the model gave none. */
  cwe: string | null;
  description: string;
  impact: string;
  preconditions: string[];
  mitigation: string;
  evidence: ReviewCitation[];
}
/**
 * Why the second review dismissed a candidate: a control that defeats the attack, an
 * effect untrusted input cannot reach, source that contradicts the claim, or a repeat.
 */
export type DismissalBasis = "control" | "unreachable" | "contradicted" | "duplicate";
export interface ReviewDismissal {
  basis: DismissalBasis;
  /** Lines the second review received that decide it; empty for a duplicate. */
  evidence: ReviewCitation[];
  /** For a duplicate: the host-assigned id of the candidate it repeats. */
  duplicateOf?: string;
}
export interface ReviewFinding extends ReviewCandidate {
  id: string;
  /**
   * The second review's verdict. `unvalidated`: the second review stopped before it
   * decided, so the candidate is kept undecided; it never counts as source-supported.
   */
  validation: "source-supported" | "needs-review" | "dismissed" | "unvalidated";
  validationReason: string;
  evidence: (ReviewCitation & { snippet: string })[];
  /** What a dismissal rests on. Absent for other verdicts and on earlier reviews. */
  dismissal?: Omit<ReviewDismissal, "evidence"> & {
    evidence: (ReviewCitation & { snippet: string })[];
  };
  /** The second review dismissed it without a basis the host could check, so it needs review. */
  uncheckedDismissal?: true;
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
  /** How discovery closed the traced paths it was given, keyed by host path id. */
  closures: PathClosure[];
  limitations: string[];
}

/**
 * A path the static scan traced from an entry point, tool, agent or model output to an
 * effect. The host lists it; the review closes it.
 */
export interface TracedPath {
  /** Host-assigned, stable within one scan: `path-1`, `path-2`. */
  id: string;
  kind: "entry-point" | "tool" | "agent" | "model-output";
  /** A route, tool or agent name, or the model call's target. */
  label: string;
  at: { path: string; line: number };
  effects: { kind: string; path: string; line: number }[];
}
/** Discovery's account of one traced path, as the host checked it. */
export interface PathClosure {
  id: string;
  /** `finding`: a candidate reports it. `safe`: cited lines keep input from the effect. */
  closure: "finding" | "safe" | "open";
  /** For `finding`: the candidate's index in discovery's findings. */
  finding?: number;
  reason: string;
  evidence: ReviewCitation[];
}
/** A traced path as a review saved it. `unclosed`: no closure that checks out. */
export interface ReviewPath extends TracedPath {
  closure: PathClosure["closure"] | "unclosed";
  /** For `finding`: the host-assigned id of the candidate that reports it. */
  findingId?: string;
  /** The review's reason, or the host's note for an unclosed path. */
  reason: string;
  evidence: (ReviewCitation & { snippet: string })[];
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
/** How one model request was configured, so results can be compared across runs. */
export interface ReviewSampling {
  provider: string;
  model: string;
  /** Null uses the model's default. */
  temperature: number | null;
  /** The output ceiling the host sent; null lets it follow the model's reported limit. */
  maxOutputTokens: number | null;
  /** The response schema was sent as the provider's structured output contract. */
  structuredOutput: boolean;
}

/** What produced a review: the exact instructions and each request's settings. */
export interface ReviewGeneration {
  /** SHA-256 of the discovery and validation instructions with their schemas. */
  promptDigest: string;
  discovery: ReviewSampling;
  /** Present once candidates went to a second review. */
  validation?: ReviewSampling;
}

/** A file the second review read besides the batch, and how it relates to a cited file. */
export interface RelatedSourceFile extends ReviewSourceFile {
  relation: "imported" | "caller";
  /** The cited file that imports it, or that it calls. */
  via: string;
}
/** A phase of an exploring review: its own conversation with read tools. */
export type ExplorePhase = "discovery" | "validation";

/** Why an exploring session ended. */
export type ExploreStop =
  | "submitted"
  | "model-calls"
  | "tool-bytes"
  | "request-size"
  | "time"
  | "tokens"
  | "invalid"
  | "failed";

/** How each stop reads in a review's reasons and limitations. */
export const EXPLORE_STOPS: Record<ExploreStop, string> = {
  submitted: "after its submission",
  "model-calls": "at its model call limit",
  "tool-bytes": "at its limit on bytes returned by tools",
  "request-size": "at its request size limit",
  time: "at its time limit",
  tokens: "at its token limit",
  invalid: "after an invalid answer",
  failed: "on a provider error, refusal or budget stop",
};

/** What one exploring session did, saved with the review. Paths and queries are redacted. */
export interface ExploreSessionRecord {
  phase: ExplorePhase;
  stop: ExploreStop;
  modelCalls: number;
  toolCalls: Record<string, number>;
  bytesReturned: number;
  /** Files the session received, with the ranges read (null: the whole file). */
  reads: { path: string; ranges: ReviewRange[] | null; digest: string }[];
  searches: { query: string; prefix: string | null; matches: number }[];
  /** The host's reasons for rejected submissions: field locations, never model values. */
  rejected?: string[];
  /** Replies cut at the output allowance, which the session discarded. */
  cutReplies?: number;
}

/** How a review read the source: one host-packed batch, or model-chosen reads. */
export type ReviewMode = "batch" | "explore";

export interface SecurityReview extends Omit<ReviewDiscovery, "status" | "findings" | "closures"> {
  schemaVersion: 1;
  id: string;
  scanId: string;
  createdAt: string;
  kind: "ai-security-review";
  status: "completed" | "refused" | "failed" | "cancelled";
  /** Absent on reviews from before exploration, which are batch reviews. */
  mode?: ReviewMode;
  /** For an exploring review: its sessions, in order. */
  exploration?: ExploreSessionRecord[];
  provider: { id: string; name: string; model: string };
  /** The connection that ran the second review, when it was not `provider`. */
  validator?: { id: string; name: string; model: string };
  /** Absent on reviews saved before prompts and settings were recorded. */
  generation?: ReviewGeneration;
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
    /** The batch budget this review used; absent on earlier reviews, which used the defaults. */
    budget?: ReviewBudget;
  };
  request: {
    calls: number;
    usage: TokenUsage | null;
    durationMs: number;
    /** Claude usage and cost of the discovery connection, and of the second review without a validator. */
    billing?: ReviewBilling;
    /** Claude usage and cost of a separate second-review connection. */
    validatorBilling?: ReviewBilling;
    /**
     * What this batch charged against the scan's limit: accounted tokens, which keep the
     * reservation of a call without reported usage, and the matching USD when every
     * request was priced. Absent on older reviews.
     */
    charged?: { tokens: number; usd: number | null };
    /** The scan's limit stopped this batch before one of its requests. */
    limitReached?: true;
  };
  findings: ReviewFinding[];
  /** The traced paths this review was asked to close. Absent on earlier reviews. */
  paths?: ReviewPath[];
}

const REVIEW_STATES = ["completed", "refused"] as const;
const CONFIDENCES = ["high", "medium", "low"] as const;
const STRIDE_STATES = ["identified", "not-observed", "insufficient-context"] as const;
const VERDICTS = ["source-supported", "needs-review", "dismissed"] as const;
const DISMISSAL_BASES = ["control", "unreachable", "contradicted", "duplicate"] as const;
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
  cwe: {
    anyOf: [{ type: "string", maxLength: 16 }, { type: "null" }],
    description: "The CWE id that best names the weakness, such as CWE-89, or null when none fits.",
  },
  description: text,
  impact: text,
  preconditions: list(text, 4),
  mitigation: text,
  evidence: list(citation(), SECURITY_REVIEW_LIMITS.evidence, 1),
};
function citation(): Schema {
  return object({
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
  });
}
const decisionProperties = {
  id: text,
  verdict: { enum: VERDICTS },
  reason: text,
  basis: {
    anyOf: [{ enum: DISMISSAL_BASES }, { type: "null" }],
    description:
      "For dismissed: control, unreachable, contradicted or duplicate. Null for other verdicts.",
  },
  evidence: {
    ...list(citation(), SECURITY_REVIEW_LIMITS.dismissalEvidence),
    description:
      "For a dismissal on control, unreachable or contradicted: the received lines that decide it, the control with role guard. Empty otherwise.",
  },
  duplicateOf: {
    anyOf: [text, { type: "null" }],
    description:
      "For a duplicate: the host-assigned id of the candidate it repeats. Otherwise null.",
  },
};
const CLOSURES = ["finding", "safe", "open"] as const;
const closureProperties = {
  id: text,
  closure: { enum: CLOSURES },
  finding: {
    anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
    description:
      "For finding: the 0-based index in findings of the candidate that reports this path. Otherwise null.",
  },
  reason: text,
  evidence: {
    ...list(citation(), SECURITY_REVIEW_LIMITS.closureEvidence),
    description:
      "For safe: the received lines with the control, or the code that keeps untrusted input from the effect. Empty otherwise.",
  },
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
  paths: {
    ...list(object(closureProperties), SECURITY_REVIEW_LIMITS.paths),
    description:
      "One closure per entry of tracedPaths, by its id. Empty when tracedPaths is absent or when refusing.",
  },
  limitations: list(text, 8, 1),
};
export const REVIEW_DISCOVERY_SCHEMA = object(discoveryProperties);
export const REVIEW_VALIDATION_SCHEMA = object({
  status: { enum: REVIEW_STATES },
  reason: reviewReason,
  decisions: list(object(decisionProperties), SECURITY_REVIEW_LIMITS.findings),
});

/**
 * Canonicalize enums and completed-review reasons. Paths and host-assigned ids remain exact.
 * `pathIds` are the traced paths the review was given; closures of other ids are dropped,
 * and one that does not check out is left out, so the host lists its path as unclosed.
 */
export function parseReviewDiscovery(
  content: string,
  files: ReviewSourceFile[],
  pathIds: readonly string[] = [],
): ReviewDiscovery {
  const parsed = parse(content);
  // A model without structured output, or a review given no paths, may leave them out.
  const raw =
    isRecord(parsed) && !Object.hasOwn(parsed, "paths") ? { ...parsed, paths: [] } : parsed;
  const data = fields(raw, Object.keys(discoveryProperties), "$");
  const status = state(data);
  const scope = new Map(files.map((file) => [file.path, file]));
  const findings = array(data.findings, SECURITY_REVIEW_LIMITS.findings, "$.findings").map(
    (value, index) => {
      const location = `$.findings[${index}]`;
      // A model without structured output may leave out the CWE; that is no reason to fail.
      const raw = isRecord(value) && !Object.hasOwn(value, "cwe") ? { ...value, cwe: null } : value;
      const item = fields(raw, Object.keys(candidateProperties), location);
      const evidence = citations(item.evidence, scope, `${location}.evidence`);
      if (!evidence.length)
        throw invalid(`${location}.evidence`, "at least one source citation is required");
      return {
        title: string(item.title, `${location}.title`),
        severity: enumValue(item.severity, SEVERITIES, `${location}.severity`),
        confidence: enumValue(item.confidence, CONFIDENCES, `${location}.confidence`),
        category: enumValue(item.category, STRIDE, `${location}.category`),
        cwe: cweId(item.cwe),
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
  const closures = pathClosures(data.paths, pathIds, findings.length, scope);
  if (status === "refused" && closures.length)
    throw invalid("$.paths", "a refusal must have no path closures");
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
    closures,
    limitations,
  };
}

/**
 * The closures that check out: a known path id, once; a finding that exists; a safe
 * closure that cites lines the review received. The rest are dropped without failing the
 * review, which then lists those paths as unclosed.
 */
function pathClosures(
  value: unknown,
  ids: readonly string[],
  findings: number,
  scope: Map<string, ReviewSourceFile>,
): PathClosure[] {
  const seen = new Set<string>();
  const closures: PathClosure[] = [];
  array(value, SECURITY_REVIEW_LIMITS.paths, "$.paths").forEach((value, index) => {
    const location = `$.paths[${index}]`;
    const raw = isRecord(value) ? { finding: null, evidence: [], ...value } : value;
    const item = fields(raw, Object.keys(closureProperties), location);
    const id = string(item.id, `${location}.id`);
    const closure = enumValue(item.closure, CLOSURES, `${location}.closure`);
    const reason = clipped(item.reason, `${location}.reason`);
    if (!ids.includes(id) || seen.has(id)) return;
    if (closure === "finding") {
      const finding = item.finding;
      if (typeof finding !== "number" || !Number.isSafeInteger(finding) || finding >= findings)
        return;
      seen.add(id);
      closures.push({ id, closure, finding, reason, evidence: [] });
      return;
    }
    let evidence: ReviewCitation[] = [];
    if (closure === "safe") {
      try {
        evidence = citations(
          item.evidence,
          scope,
          `${location}.evidence`,
          SECURITY_REVIEW_LIMITS.closureEvidence,
        );
      } catch (error) {
        if (!(error instanceof ReviewResponseError)) throw error;
      }
      if (!evidence.length) return;
    }
    seen.add(id);
    closures.push({ id, closure, reason, evidence });
  });
  return closures;
}

export interface ReviewDecision {
  id: string;
  verdict: ReviewFinding["validation"];
  reason: string;
  dismissal?: ReviewDismissal;
  /** A dismissal the host could not check, now needs-review; `reason` says why first. */
  unchecked?: true;
}

/** Host notes for a dismissal it keeps as needs-review. They never quote the model. */
const UNCHECKED = {
  basis: "The second review dismissed this candidate without naming its basis",
  evidence:
    "The second review dismissed this candidate without citing a control or source line it received",
  duplicate:
    "The second review dismissed this candidate as a duplicate without naming another candidate that is kept",
};

/**
 * `files` is what the second review received: a dismissal on a control, an unreachable
 * effect or contradicting source must cite those lines. One that names no basis, cites
 * nothing it received, or repeats a candidate that is not kept becomes needs-review.
 */
export function parseReviewValidation(
  content: string,
  ids: string[],
  files: readonly ReviewSourceFile[],
): {
  status: "completed" | "refused";
  reason: string | null;
  decisions: ReviewDecision[];
} {
  const value = fields(parse(content), ["status", "reason", "decisions"], "$");
  const status = state(value);
  const remaining = new Set(ids);
  const scope = new Map(files.map((file) => [file.path, file]));
  const parsed = array(value.decisions, SECURITY_REVIEW_LIMITS.findings, "$.decisions").map(
    (value, index) => {
      const location = `$.decisions[${index}]`;
      // A model without structured output may leave out what only a dismissal needs.
      const raw = isRecord(value)
        ? { basis: null, evidence: [], duplicateOf: null, ...value }
        : value;
      const decision = fields(raw, Object.keys(decisionProperties), location);
      const id = string(decision.id, `${location}.id`);
      if (!remaining.delete(id))
        throw invalid(`${location}.id`, "unknown or duplicate host-assigned candidate id");
      const verdict = enumValue(decision.verdict, VERDICTS, `${location}.verdict`);
      const reason = clipped(decision.reason, `${location}.reason`);
      if (verdict !== "dismissed") return { id, verdict, reason };
      const basis =
        decision.basis === null
          ? null
          : enumValue(decision.basis, DISMISSAL_BASES, `${location}.basis`);
      if (basis === null) return unchecked(id, reason, UNCHECKED.basis);
      if (basis === "duplicate") {
        const target = typeof decision.duplicateOf === "string" ? decision.duplicateOf : "";
        return target !== id && ids.includes(target)
          ? { id, verdict, reason, dismissal: { basis, evidence: [], duplicateOf: target } }
          : unchecked(id, reason, UNCHECKED.duplicate);
      }
      let evidence: ReviewCitation[] = [];
      try {
        evidence = citations(
          decision.evidence,
          scope,
          `${location}.evidence`,
          SECURITY_REVIEW_LIMITS.dismissalEvidence,
        );
      } catch (error) {
        if (!(error instanceof ReviewResponseError)) throw error;
      }
      return evidence.length
        ? { id, verdict, reason, dismissal: { basis, evidence } }
        : unchecked(id, reason, UNCHECKED.evidence);
    },
  );
  // A duplicate stands only beside the candidate it repeats; two that point at each
  // other, or at one dismissed for another reason, would leave nothing reported.
  const dismissed = new Set(
    parsed.filter((item) => item.verdict === "dismissed").map((item) => item.id),
  );
  const decisions = parsed.map((item) =>
    item.dismissal?.duplicateOf !== undefined && dismissed.has(item.dismissal.duplicateOf)
      ? unchecked(item.id, item.reason, UNCHECKED.duplicate)
      : item,
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

function unchecked(id: string, reason: string, note: string): ReviewDecision {
  return {
    id,
    verdict: "needs-review",
    reason: `${note}, so it needs review. Second review: ${reason}`,
    unchecked: true,
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
  maximum: number = SECURITY_REVIEW_LIMITS.evidence,
): ReviewCitation[] {
  return array(value, maximum, location).map((value, index) => {
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
/** `CWE-89` from `CWE-89`, `cwe-89` or `89`; null for anything else, which never fails a review. */
function cweId(value: unknown): string | null {
  const match =
    typeof value === "string" || typeof value === "number"
      ? /^(?:cwe-?)?\s*([1-9]\d{0,4})$/i.exec(String(value).trim())
      : null;
  return match === null ? null : `CWE-${match[1]}`;
}
function string(value: unknown, location: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > SECURITY_REVIEW_LIMITS.text)
    throw invalid(
      location,
      `expected non-empty text of at most ${SECURITY_REVIEW_LIMITS.text} characters`,
    );
  return value.trim();
}
/** A decision's reason past the text limit is cut, with a note, rather than failing the decision. */
const CUT_NOTE = " … (cut at the review's text limit)";
function clipped(value: unknown, location: string): string {
  if (typeof value !== "string" || !value.trim())
    throw invalid(location, "expected non-empty text");
  const reason = value.trim();
  if (reason.length <= SECURITY_REVIEW_LIMITS.text) return reason;
  const kept = reason.slice(0, SECURITY_REVIEW_LIMITS.text - CUT_NOTE.length);
  // End at a word where one is near, so the cut does not split a path or a name.
  const space = kept.lastIndexOf(" ");
  return `${(space > kept.length - 80 ? kept.slice(0, space) : kept).trimEnd()}${CUT_NOTE}`;
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
