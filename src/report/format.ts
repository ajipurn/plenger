import { sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Location } from "../inventory/model.ts";
import type { Severity } from "../rules/index.ts";
import { SEVERITIES } from "../rules/model.ts";
import { activeFindings, type Report } from "./model.ts";
import { formatSummary, type SummaryOptions } from "./summary.ts";

export const FORMATS = ["terminal", "json", "sarif", "markdown"] as const;
export type ReportFormat = (typeof FORMATS)[number];

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function formatReport(
  report: Report,
  format: ReportFormat,
  options: SummaryOptions,
): string {
  if (format === "json") return json(report);
  if (format === "sarif") return json(toSarif(report));
  if (format === "markdown") return toMarkdown(report);
  let text = formatSummary({ ...report, findings: activeFindings(report) }, options);
  if (report.review.suppressed > 0 && report.review.active === 0) {
    text = text.replace(
      "No risks detected by plenger's rules. This is not proof that there are none.",
      "All detected findings are suppressed. Review their reasons in JSON, SARIF or Markdown.",
    );
  }
  if (report.review.suppressed > 0 || report.findings.some((item) => item.baselineState)) {
    const { active, suppressed, unchanged } = report.review;
    text += `\n  Review: ${active} active · ${suppressed} suppressed · ${unchanged} in baseline\n`;
  }
  return text;
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

/** Relative URI, not a path: preserve slashes but escape spaces, %, #, Unicode and delimiters. */
export function artifactUri(path: string): string {
  return path
    .split("/")
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

function physicalLocation(location: Location, snippet?: string) {
  return {
    artifactLocation: { uri: artifactUri(location.path), uriBaseId: "%SRCROOT%" },
    region: {
      startLine: location.line,
      startColumn: location.column,
      endLine: location.endLine,
      endColumn: location.endColumn,
      ...(snippet ? { snippet: { text: snippet } } : {}),
    },
  };
}

export function toSarif(report: Report) {
  const warnings: string[] = [];
  const syntaxErrors = report.files.filter((file) => file.syntaxErrors).length;
  const skipped = report.skipped.filter((file) =>
    ["unreadable", "too_large", "binary", "not_utf8"].includes(file.reason),
  ).length;
  if (syntaxErrors)
    warnings.push(
      `${syntaxErrors} ${syntaxErrors === 1 ? "file has" : "files have"} syntax errors; results may be incomplete.`,
    );
  if (skipped)
    warnings.push(
      `${skipped} source ${skipped === 1 ? "file" : "files"} could not be analysed; see run.properties.skipped.`,
    );
  if (report.truncated) warnings.push("File limit reached; this scan is truncated.");
  return {
    $schema: "https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: report.tool.name,
            version: report.tool.version,
            rules: report.rules.map((rule) => ({
              id: rule.id,
              name: rule.name,
              shortDescription: { text: rule.title },
              fullDescription: { text: rule.description },
              help: { text: rule.remediation },
              defaultConfiguration: { level: LEVELS[rule.severity] },
              properties: {
                tags: ["security", ...rule.owasp, ...rule.cwe.map((id) => `CWE-${id}`)],
                "security-severity": SECURITY_SEVERITY[rule.severity],
              },
            })),
          },
        },
        columnKind: "utf16CodeUnits",
        invocations: [
          {
            executionSuccessful: true,
            toolExecutionNotifications: warnings.map((text) => ({
              level: "warning",
              message: { text },
            })),
          },
        ],
        originalUriBaseIds: {
          "%SRCROOT%": {
            uri: pathToFileURL(report.root.endsWith(sep) ? report.root : `${report.root}${sep}`)
              .href,
          },
        },
        results: report.findings.map((finding) => ({
          ruleId: finding.rule,
          ruleIndex: report.rules.findIndex((rule) => rule.id === finding.rule),
          level: LEVELS[finding.severity],
          message: { text: [finding.title, ...finding.notes].join("\n") },
          locations: [{ physicalLocation: physicalLocation(finding.location, finding.snippet) }],
          relatedLocations: finding.evidence.map((evidence, index) => ({
            id: index + 1,
            physicalLocation: physicalLocation(evidence.location, evidence.snippet),
            message: { text: evidence.message },
          })),
          partialFingerprints: { "plenger/v1": finding.fingerprint },
          ...(finding.baselineState ? { baselineState: finding.baselineState } : {}),
          ...(finding.suppression
            ? {
                suppressions: [
                  {
                    kind: "external",
                    status: "accepted",
                    justification: finding.suppression.reason,
                  },
                ],
              }
            : {}),
          properties: {
            severity: finding.severity,
            confidence: finding.confidence,
            score: finding.score,
            exposed: finding.exposed,
            subject: finding.subject,
            "security-severity": SECURITY_SEVERITY[finding.severity],
          },
        })),
        properties: {
          review: report.review,
          truncated: report.truncated,
          syntaxErrorFiles: report.files
            .filter((file) => file.syntaxErrors)
            .map((file) => file.path),
          skipped: report.skipped,
          excludedDirs: report.excludedDirs,
        },
      },
    ],
  };
}

/** Escape source-derived text so it cannot turn into HTML, images or extra Markdown structure. */
export function markdownText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replace(/[\\`*_{}[\]()#+.!|<>~-]/g, "\\$&")
    .replace(/\r?\n/g, " ");
}

function codeBlock(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(([match]) => match.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

function sourceLink(location: Location, sourceBaseUrl = ""): string {
  return `[${markdownText(`${location.path}:${location.line}`)}](${sourceBaseUrl}${artifactUri(location.path)}#L${location.line})`;
}

export function toMarkdown(report: Report, options: { sourceBaseUrl?: string } = {}): string {
  const { active, suppressed, unchanged } = report.review;
  const syntaxErrors = report.files.filter((file) => file.syntaxErrors).length;
  const lines = [
    "# plenger scan",
    "",
    `plenger ${markdownText(report.tool.version)} · ${report.files.length} ${report.files.length === 1 ? "file" : "files"} parsed · ${report.skipped.length} ${report.skipped.length === 1 ? "file" : "files"} skipped`,
    "",
    `${active} active ${active === 1 ? "finding" : "findings"} · ${suppressed} suppressed · ${unchanged} in baseline`,
    "",
    "| Severity | Active |",
    "| --- | ---: |",
    ...SEVERITIES.map(
      (severity) =>
        `| ${severity} | ${activeFindings(report).filter((finding) => finding.severity === severity).length} |`,
    ),
    "",
    "## Agent inventory",
    "",
    ...Object.entries(report.inventory).map(([kind, items]) => `- ${kind}: ${items.length}`),
    "",
    "## Coverage",
    "",
    `Scan truncated: ${report.truncated ? "yes" : "no"}. ${syntaxErrors} ${syntaxErrors === 1 ? "file has" : "files have"} syntax errors; results may be incomplete.`,
    "",
    ...report.files
      .filter((file) => file.syntaxErrors)
      .map((file) => `- Syntax errors: ${markdownText(file.path)}`),
    ...report.skipped.map((file) => `- Skipped: ${markdownText(file.path)} (${file.reason})`),
    ...report.excludedDirs.map(
      (dir) => `- Excluded directory: ${markdownText(dir.path)} (${dir.reason})`,
    ),
    "",
    "## Findings",
    "",
  ];
  if (report.findings.length === 0) {
    lines.push("No risks detected by plenger's rules. This is not proof that there are none.", "");
  }
  for (const finding of report.findings) {
    const rule = report.rules.find((item) => item.id === finding.rule);
    lines.push(
      `### ${finding.rule}: ${markdownText(finding.title)}`,
      "",
      `${finding.severity} · ${finding.confidence} confidence · score ${finding.score}${finding.exposed ? " · exposed" : ""}`,
      "",
      `${sourceLink(finding.location, options.sourceBaseUrl)} · fingerprint \`${finding.fingerprint}\`${finding.baselineState ? ` · baseline: ${finding.baselineState}` : ""}`,
      "",
    );
    if (finding.suppression)
      lines.push(`Suppressed: ${markdownText(finding.suppression.reason)}`, "");
    if (finding.snippet) lines.push(codeBlock(finding.snippet), "");
    for (const evidence of finding.evidence) {
      lines.push(
        `- ${sourceLink(evidence.location, options.sourceBaseUrl)}: ${markdownText(evidence.message)}`,
      );
    }
    if (finding.evidence.length) lines.push("");
    for (const note of finding.notes) lines.push(`- ${markdownText(note)}`);
    if (finding.notes.length) lines.push("");
    if (rule)
      lines.push(
        `Remediation: ${markdownText(rule.remediation)}`,
        "",
        `Mappings: ${[...rule.owasp, ...rule.cwe.map((id) => `CWE-${id}`)].map(markdownText).join(", ")}`,
        "",
      );
  }
  return `${lines.join("\n")}\n`;
}
