import { isAbsolute, relative, sep } from "node:path";
import type { Location } from "../inventory/model.ts";
import type { Rule, Severity } from "../rules/index.ts";
import { SEVERITIES } from "../rules/model.ts";
import { traceGapText } from "../rules/text.ts";
import { json } from "../shared/json.ts";
import { activeFindings, incompleteTraces, type Report, type ReportFinding } from "./model.ts";
import { formatSummary, type SummaryOptions } from "./summary.ts";

export const FORMATS = ["terminal", "json", "sarif", "markdown"] as const;
export type ReportFormat = (typeof FORMATS)[number];

interface SourceOptions {
  /**
   * Real path of the directory that SARIF and Markdown paths are relative to, such as
   * the repository root; the scan root when absent. It must contain the scan root.
   */
  sourceRoot?: string;
}

export class SourceRootError extends Error {}

/**
 * Where the scan root is inside the source root, with forward slashes (`src`); empty
 * when they are the same directory or no source root is given.
 */
export function sourcePrefix(report: Pick<Report, "root">, sourceRoot?: string): string {
  if (sourceRoot === undefined) return "";
  const path = relative(sourceRoot, report.root);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new SourceRootError(`the scanned path is not inside the source root ${sourceRoot}`);
  }
  return path.split(sep).join("/");
}

export function formatReport(
  report: Report,
  format: ReportFormat,
  options: SummaryOptions & SourceOptions,
): string {
  if (format === "json") return json(report);
  if (format === "sarif") return json(toSarif(report, options));
  if (format === "markdown") return toMarkdown(report, options);
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

/** A scan-root-relative path made relative to the source root. */
function sourcePath(path: string, prefix: string): string {
  return prefix === "" ? path : `${prefix}/${path}`;
}

function physicalLocation(location: Location, prefix: string, snippet?: string) {
  return {
    artifactLocation: {
      uri: artifactUri(sourcePath(location.path, prefix)),
      uriBaseId: "%SRCROOT%",
    },
    region: {
      startLine: location.line,
      startColumn: location.column,
      endLine: location.endLine,
      endColumn: location.endColumn,
      ...(snippet ? { snippet: { text: snippet } } : {}),
    },
  };
}

/**
 * SARIF tools such as GitHub code scanning read severity from the rule, not the
 * result. A rule's findings rated below its highest severity are reported under a
 * descriptor per severity, `PLG302/low`, so that each alert shows its own severity.
 */
function ruleDescriptors(rules: Rule[], findings: ReportFinding[]) {
  const descriptors: { id: string; rule: Rule; severity: Severity }[] = [];
  for (const rule of rules) {
    const used = new Set(
      findings.filter((finding) => finding.rule === rule.id).map((finding) => finding.severity),
    );
    descriptors.push({ id: rule.id, rule, severity: rule.severity });
    for (const severity of SEVERITIES) {
      if (severity !== rule.severity && used.has(severity))
        descriptors.push({ id: `${rule.id}/${severity}`, rule, severity });
    }
  }
  return descriptors;
}

export function toSarif(report: Report, options: SourceOptions = {}) {
  const prefix = sourcePrefix(report, options.sourceRoot);
  const descriptors = ruleDescriptors(report.rules, report.findings);
  const descriptorOf = (finding: ReportFinding) => {
    const index = descriptors.findIndex(
      (item) => item.rule.id === finding.rule && item.severity === finding.severity,
    );
    return index === -1 ? descriptors.findIndex((item) => item.id === finding.rule) : index;
  };
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
  const traces = incompleteTraces(report.inventory).length;
  if (traces)
    warnings.push(
      `${traces} ${traces === 1 ? "handler was" : "handlers were"} traced incompletely; affected findings note the calls that were not followed.`,
    );
  return {
    $schema: "https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: report.tool.name,
            version: report.tool.version,
            rules: descriptors.map(({ id, rule, severity }) => ({
              id,
              name: rule.name,
              shortDescription: { text: rule.title },
              fullDescription: { text: rule.description },
              help: { text: rule.remediation },
              defaultConfiguration: { level: LEVELS[severity] },
              properties: {
                tags: ["security", ...rule.owasp, ...rule.cwe.map((cwe) => `CWE-${cwe}`)],
                "security-severity": SECURITY_SEVERITY[severity],
                rule: rule.id,
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
        // %SRCROOT% is the source root; its local absolute path is not written, so
        // reports can be shared and uploaded without revealing the machine they came from.
        results: report.findings.map((finding) => {
          const ruleIndex = descriptorOf(finding);
          return {
            ruleId: descriptors[ruleIndex]?.id ?? finding.rule,
            ruleIndex,
            level: LEVELS[finding.severity],
            message: { text: [finding.title, ...finding.notes].join("\n") },
            locations: [
              { physicalLocation: physicalLocation(finding.location, prefix, finding.snippet) },
            ],
            relatedLocations: finding.evidence.map((evidence, index) => ({
              id: index + 1,
              physicalLocation: physicalLocation(evidence.location, prefix, evidence.snippet),
              message: { text: evidence.message },
            })),
            // The evidence chain as a path that code scanning UIs can step through.
            ...(finding.evidence.length > 1
              ? {
                  codeFlows: [
                    {
                      threadFlows: [
                        {
                          locations: finding.evidence.map((evidence) => ({
                            location: {
                              physicalLocation: physicalLocation(
                                evidence.location,
                                prefix,
                                evidence.snippet,
                              ),
                              message: { text: evidence.message },
                            },
                          })),
                        },
                      ],
                    },
                  ],
                }
              : {}),
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
              rule: finding.rule,
              severity: finding.severity,
              confidence: finding.confidence,
              score: finding.score,
              exposed: finding.exposed,
              subject: finding.subject,
              "security-severity": SECURITY_SEVERITY[finding.severity],
            },
          };
        }),
        properties: {
          review: report.review,
          truncated: report.truncated,
          syntaxErrorFiles: report.files
            .filter((file) => file.syntaxErrors)
            .map((file) => sourcePath(file.path, prefix)),
          skipped: report.skipped.map((file) => ({ ...file, path: sourcePath(file.path, prefix) })),
          excludedDirs: report.excludedDirs.map((dir) => ({
            ...dir,
            path: sourcePath(dir.path, prefix),
          })),
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

function sourceLink(location: Location, prefix: string, sourceBaseUrl = ""): string {
  const path = sourcePath(location.path, prefix);
  return `[${markdownText(`${path}:${location.line}`)}](${sourceBaseUrl}${artifactUri(path)}#L${location.line})`;
}

export function toMarkdown(
  report: Report,
  options: SourceOptions & { sourceBaseUrl?: string } = {},
): string {
  const prefix = sourcePrefix(report, options.sourceRoot);
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
    ...incompleteTraces(report.inventory).map(
      ({ name, location, trace }) =>
        `- Trace incomplete: ${markdownText(name)} (${markdownText(sourcePath(location.path, prefix))}:${location.line}): ${traceGapText(trace)}`,
    ),
    ...report.skipped.map((file) => `- Skipped: ${markdownText(file.path)} (${file.reason})`),
    ...(report.binaries ?? []).map(
      (file) =>
        `- Binary not analysed: ${markdownText(file.path)} (${file.kind}, ${file.bytes} bytes${file.sha256 ? `, SHA-256 \`${file.sha256}\`` : ""})`,
    ),
    ...report.excludedDirs.map(
      (dir) => `- Excluded directory: ${markdownText(dir.path)} (${dir.reason})`,
    ),
    "",
    "## Findings",
    "",
  ];
  if (report.findings.length === 0) {
    lines.push(
      "No risks detected by plenger's rules. This is not proof that there are none.",
      "",
    );
  }
  for (const finding of report.findings) {
    const rule = report.rules.find((item) => item.id === finding.rule);
    lines.push(
      `### ${finding.rule}: ${markdownText(finding.title)}`,
      "",
      `${finding.severity} · ${finding.confidence} confidence · score ${finding.score}${finding.exposed ? " · exposed" : ""}`,
      "",
      `${sourceLink(finding.location, prefix, options.sourceBaseUrl)} · fingerprint \`${finding.fingerprint}\`${finding.baselineState ? ` · baseline: ${finding.baselineState}` : ""}`,
      "",
    );
    if (finding.suppression)
      lines.push(`Suppressed: ${markdownText(finding.suppression.reason)}`, "");
    if (finding.snippet) lines.push(codeBlock(finding.snippet), "");
    for (const evidence of finding.evidence) {
      lines.push(
        `- ${sourceLink(evidence.location, prefix, options.sourceBaseUrl)}: ${markdownText(evidence.message)}`,
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
