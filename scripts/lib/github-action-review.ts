// The GitHub Action's opt-in AI review: one bounded Quick review of the checkout, or of
// the changes since a base commit, on a connection the workflow names. Its findings join
// the SARIF report as a second run, and source-supported ones count toward the gate.

import { createHash } from "node:crypto";
import {
  type ReviewMode,
  SECURITY_REVIEW_LIMITS,
  type SecurityReview,
} from "../../src/assessment/review-model.ts";
import { reviewPaths } from "../../src/assessment/review-source.ts";
import { reviewProject } from "../../src/assessment/security-review.ts";
import type { ProviderAccess } from "../../src/redteam/provider.ts";
import { validateProviderSettings } from "../../src/redteam/provider-config.ts";
import { SEVERITIES, type Severity } from "../../src/rules/model.ts";
import type { ScanResult } from "../../src/scan.ts";
import { type ChangeScope, changesSince } from "../../src/security/changes.ts";
import { SCAN_BUDGET_LIMITS } from "../../src/security/model.ts";

export interface AiReviewInputs {
  access: ProviderAccess;
  tokens: number;
  mode: ReviewMode;
  changesSince: string | null;
}

const PROVIDERS = ["anthropic", "openai", "gemini", "ollama"] as const;

/** The AI review inputs, null when the review is off, or the message for a bad input. */
export function aiReviewInputs(
  env: Record<string, string | undefined>,
): AiReviewInputs | null | string {
  const enabled = env.PLENGER_AI_REVIEW ?? "";
  if (enabled === "" || enabled === "false") return null;
  if (enabled !== "true") return "ai-review input must be true or false";
  const provider = env.PLENGER_AI_PROVIDER || "anthropic";
  if (!(PROVIDERS as readonly string[]).includes(provider))
    return "ai-provider must be anthropic, openai, gemini or ollama";
  const model = env.PLENGER_AI_MODEL ?? "";
  const apiKey = env.PLENGER_AI_API_KEY || undefined;
  const baseUrl = env.PLENGER_AI_BASE_URL || undefined;
  try {
    validateProviderSettings({ provider, model, apiKey, baseUrl });
  } catch {
    return "ai-model must name a model of ai-provider, and ai-api-key and ai-base-url must be valid";
  }
  if (provider !== "ollama" && !apiKey) return "ai-api-key is required for the AI review";
  const tokens = Number(env.PLENGER_AI_TOKEN_LIMIT);
  if (
    !Number.isSafeInteger(tokens) ||
    tokens < SCAN_BUDGET_LIMITS.minTokens ||
    tokens > SCAN_BUDGET_LIMITS.maxTokens
  )
    return `ai-token-limit must be an integer from ${SCAN_BUDGET_LIMITS.minTokens} to ${SCAN_BUDGET_LIMITS.maxTokens}`;
  const mode = env.PLENGER_AI_MODE || "batch";
  if (mode !== "batch" && mode !== "explore") return "ai-mode must be batch or explore";
  return {
    access: {
      provider: provider as (typeof PROVIDERS)[number],
      model,
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      temperature: null,
      maxOutputTokens: SECURITY_REVIEW_LIMITS.outputTokens,
    },
    tokens,
    mode,
    changesSince: env.PLENGER_AI_CHANGES_SINCE?.trim() || null,
  };
}

/** One Quick review; none when a change review finds no changed file to read. */
export async function runAiReview(
  inputs: AiReviewInputs,
  snapshot: ScanResult,
  root: string,
): Promise<{ review: SecurityReview | null; changes?: ChangeScope }> {
  const changes = inputs.changesSince
    ? await changesSince(root, inputs.changesSince, reviewPaths(snapshot))
    : undefined;
  if (changes && !changes.files.length) return { review: null, changes };
  const review = await reviewProject(snapshot, {
    scanId: "github-action",
    provider: { id: "github-action", name: inputs.access.provider, model: inputs.access.model },
    access: inputs.access,
    limit: { kind: "tokens", tokens: inputs.tokens },
    mode: inputs.mode,
    ...(changes ? { changes } : {}),
  });
  return { review, ...(changes ? { changes } : {}) };
}

const LEVELS: Record<Severity, string> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "note",
};
const SECURITY_SEVERITY: Record<Severity, string> = {
  critical: "9.0",
  high: "7.0",
  medium: "4.0",
  low: "2.0",
};

/** Kept findings: dismissed candidates stay in the review record only. */
const kept = (review: SecurityReview) =>
  review.findings.filter((finding) => finding.validation !== "dismissed");

/** A second SARIF run with the review's kept findings, paths under the source root. */
export function aiSarifRun(review: SecurityReview, prefix: string) {
  const uri = (path: string) => (prefix ? `${prefix}/${path}` : path);
  const findings = kept(review);
  const rules = [...new Set(findings.map((finding) => ruleId(finding.cwe)))].sort();
  return {
    tool: {
      driver: {
        name: "plenger-ai-review",
        rules: rules.map((id) => ({
          id,
          shortDescription: {
            text: id === "AI-REVIEW" ? "AI review finding" : `AI review: ${id.slice(3)}`,
          },
          properties: { tags: ["security", ...(id === "AI-REVIEW" ? [] : [id.slice(3)])] },
        })),
      },
    },
    columnKind: "utf16CodeUnits",
    invocations: [
      {
        executionSuccessful: review.status === "completed",
        toolExecutionNotifications: [
          {
            level: "note",
            message: { text: "Source analysis by a model; findings are not runtime validated." },
          },
        ],
      },
    ],
    results: findings.map((finding) => {
      const [primary, ...related] = finding.evidence;
      const location = (cite: { path: string; line: number; endLine: number }) => ({
        artifactLocation: { uri: uri(cite.path), uriBaseId: "%SRCROOT%" },
        region: { startLine: cite.line, endLine: cite.endLine },
      });
      return {
        ruleId: ruleId(finding.cwe),
        level: LEVELS[finding.severity],
        message: {
          text: `${finding.title}\n${finding.description}\nSecond review: ${finding.validation}.`,
        },
        locations: primary ? [{ physicalLocation: location(primary) }] : [],
        relatedLocations: related.map((cite, index) => ({
          id: index + 1,
          physicalLocation: location(cite),
          message: { text: cite.message },
        })),
        partialFingerprints: {
          "plenger-ai/v1": createHash("sha256")
            .update(`${finding.category}|${finding.cwe ?? ""}|${primary?.path}:${primary?.line}`)
            .digest("hex"),
        },
        properties: {
          "security-severity": SECURITY_SEVERITY[finding.severity],
          validation: finding.validation,
          category: finding.category,
          confidence: finding.confidence,
        },
      };
    }),
  };
}

function ruleId(cwe: string | null): string {
  return cwe ? `AI-${cwe}` : "AI-REVIEW";
}

/** Whether a source-supported finding meets the gate's severity. */
export function aiFailsGate(review: SecurityReview, threshold: string): boolean {
  if (threshold === "none") return false;
  const limit = SEVERITIES.indexOf(threshold as Severity);
  return kept(review).some(
    (finding) =>
      finding.validation === "source-supported" && SEVERITIES.indexOf(finding.severity) <= limit,
  );
}

/** The job summary section of the AI review. */
export function aiSummary(review: SecurityReview | null, changes?: ChangeScope): string {
  const scope = changes
    ? `Changes since \`${changes.base}\` (${changes.commit.slice(0, 7)}): ${changes.files.length} ${changes.files.length === 1 ? "file" : "files"} changed${changes.removed.length ? `, ${changes.removed.length} removed` : ""}.`
    : "Whole checkout, one Quick review.";
  if (!review) return `\n## Plenger AI review\n\n${scope} No changed file to review.\n`;
  const findings = kept(review);
  const rows = findings.map(
    (finding) =>
      `| ${finding.severity} | ${cell(finding.title)} | ${finding.validation} | \`${finding.evidence[0]?.path}:${finding.evidence[0]?.line}\` |`,
  );
  return [
    "",
    "## Plenger AI review",
    "",
    `${scope} Review ${review.status} with ${review.provider.model}, ${review.request.calls} model ${review.request.calls === 1 ? "request" : "requests"}. Source analysis only; not runtime validated.`,
    ...(review.status !== "completed" && review.reason ? ["", cell(review.reason)] : []),
    "",
    ...(rows.length
      ? ["| Severity | Finding | Second review | Location |", "| --- | --- | --- | --- |", ...rows]
      : ["No findings were kept."]),
    "",
  ].join("\n");
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}
