import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import { beforeAll, describe, expect, it } from "vitest";
import { artifactUri, formatReport, toMarkdown, toSarif } from "../src/report/format.ts";
import { createReport, failsGate, type Report } from "../src/report/model.ts";
import {
  createBaseline,
  matchesSuppression,
  readBaseline,
  readSuppressions,
} from "../src/report/policy.ts";
import { REPORT_SCHEMA, REPORT_SCHEMAS } from "../src/report/schema.ts";
import { SEVERITIES } from "../src/rules/model.ts";
import { scan } from "../src/scan.ts";

const ajv = new Ajv({ allErrors: true, strict: false });
const addFormats: FormatsPlugin = createRequire(import.meta.url)("ajv-formats");
addFormats(ajv);
const validateReport = ajv.compile(REPORT_SCHEMA);
// OASIS's published schema has a legacy language-tag regex that requires non-Unicode mode.
const sarifAjv = new Ajv({ allErrors: true, strict: false, unicodeRegExp: false });
addFormats(sarifAjv);
const validateSarif = sarifAjv.compile(
  JSON.parse(
    await readFile(new URL("fixtures/reports/sarif-2.1.0.schema.json", import.meta.url), "utf8"),
  ),
);
const reports: Report[] = [];
let report: Report;
beforeAll(async () => {
  for (const corpus of ["frameworks", "crossfile", "risks", "mixed-agent"]) {
    reports.push(
      createReport(
        await scan(fileURLToPath(new URL(`fixtures/${corpus}`, import.meta.url)), { facts: true }),
      ),
    );
  }
  report = reports[2] as Report;
});

describe("report contracts", () => {
  it("validates the full inventory, findings and linked facts of all fixture corpora", () => {
    for (const value of reports) {
      expect(validateReport(value), JSON.stringify(validateReport.errors)).toBe(true);
      expect(validateSarif(toSarif(value)), JSON.stringify(validateSarif.errors)).toBe(true);
    }
  });

  it("rejects a changed version, missing fields and invalid nested findings", () => {
    for (const mutate of [
      (value: Report) => {
        Object.assign(value, { schemaVersion: 0 });
      },
      (value: Report) => {
        Reflect.deleteProperty(value, "review");
      },
      (value: Report) => {
        Object.assign(value.findings[0] as object, { score: 101 });
      },
      (value: Report) => {
        Object.assign(value.findings[0]?.location as object, { line: 0 });
      },
      (value: Report) => {
        Object.assign(value.inventory.tools[0] as object, { via: "unknown" });
      },
    ]) {
      const value = structuredClone(report);
      mutate(value);
      expect(validateReport(value)).toBe(false);
    }
  });

  it("keeps the generated, distributable JSON schemas in sync", async () => {
    for (const [name, schema] of Object.entries(REPORT_SCHEMAS)) {
      expect(
        JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url), "utf8")),
      ).toEqual(schema);
    }
  });

  it("maps SARIF rule ids, evidence, severity, fingerprints and UTF-16 locations", () => {
    const run = toSarif(report).runs[0];
    expect(run?.columnKind).toBe("utf16CodeUnits");
    expect(run?.originalUriBaseIds["%SRCROOT%"].uri).toMatch(/^file:.*\/$/);
    for (const [index, result] of (run?.results ?? []).entries()) {
      const finding = report.findings[index];
      expect(run?.tool.driver.rules[result.ruleIndex]?.id).toBe(result.ruleId);
      expect(result.partialFingerprints["plenger/v1"]).toBe(finding?.fingerprint);
      expect(result.relatedLocations).toHaveLength(finding?.evidence.length ?? 0);
      expect(result.locations[0]?.physicalLocation.region.startColumn).toBe(
        finding?.location.column,
      );
    }
  });

  it("retains coverage warnings, including syntax errors, unreadable files and truncation", () => {
    const value = {
      ...report,
      truncated: true,
      files: [
        { path: "broken.py", language: "python" as const, bytes: 1, lines: 1, syntaxErrors: true },
      ],
      skipped: [{ path: "missing.py", reason: "unreadable" as const }],
    };
    const sarif = toSarif(value);
    expect(sarif.runs[0]?.invocations[0]?.toolExecutionNotifications).toHaveLength(3);
    expect(validateSarif(sarif), JSON.stringify(validateSarif.errors)).toBe(true);
    expect(toMarkdown(value)).toContain("Scan truncated: yes");
  });

  it("escapes URI delimiters and source-derived Markdown, including fence breakout", () => {
    expect(artifactUri("src/my (agent)#1%.py")).toBe("src/my%20%28agent%29%231%25.py");
    const value = structuredClone(report);
    const first = value.findings[0];
    if (!first) throw new Error("fixture needs findings");
    first.title = "<img src=x> [click](https://evil.example)";
    first.snippet = "```\n<img src=x>\n```";
    first.location.path = "my (agent).py";
    const markdown = toMarkdown(value);
    expect(markdown).toContain("\\<img src=x\\>");
    expect(markdown).toContain("\\[click\\]\\(https://evil\\.example\\)");
    expect(markdown).toContain("````text\n```\n<img src=x>\n```\n````");
    expect(markdown).toContain("(my%20%28agent%29.py#L");
  });
});

describe("baseline, suppression and finding gate", () => {
  it("redacts credentials in suppression reasons in every report format", () => {
    const secret = "sk-proj-8gHd3pNq7rTz2wXv6yBc9mLs4aEf1jUk";
    const first = report.findings[0];
    if (!first) throw new Error("fixture needs findings");
    const value = createReport(report, {
      suppressions: [{ fingerprint: first.fingerprint, reason: `Reviewed ${secret}` }],
    });
    for (const format of ["json", "sarif", "markdown"] as const) {
      const text = formatReport(value, format, { color: false });
      expect(text).not.toContain(secret);
      expect(text).toContain("redacted");
    }
  });
  it("preserves all findings and annotates reviewed items without changing the scan", () => {
    const first = report.findings[0];
    if (!first) throw new Error("fixture needs findings");
    const value = createReport(report, {
      baseline: createBaseline(report.findings),
      suppressions: [{ fingerprint: first.fingerprint, reason: "Reviewed; fixed at the gateway" }],
    });
    expect(value.findings).toHaveLength(report.findings.length);
    expect(value.review).toEqual({
      active: report.findings.length - 1,
      suppressed: 1,
      unchanged: report.findings.length,
      new: 0,
    });
    expect(value.findings[0]?.suppression?.reason).toContain("Reviewed");
    expect(report.findings[0]?.suppression).toBeUndefined();
    expect(failsGate(value, "low")).toBe(false);
    expect(validateReport(value), JSON.stringify(validateReport.errors)).toBe(true);
    const sarif = toSarif(value);
    expect(validateSarif(sarif), JSON.stringify(validateSarif.errors)).toBe(true);
    expect(sarif.runs[0]?.results[0]).toMatchObject({
      baselineState: "unchanged",
      suppressions: [
        {
          kind: "external",
          status: "accepted",
          justification: expect.stringContaining("Reviewed"),
        },
      ],
    });
  });

  it("gates severity cumulatively and excludes unchanged and suppressed findings", () => {
    for (const [rank, severity] of SEVERITIES.entries()) {
      const first = report.findings[0];
      if (!first) throw new Error("fixture needs findings");
      const value = { ...report, findings: [{ ...first, severity }] };
      for (const [thresholdRank, threshold] of SEVERITIES.entries()) {
        expect(failsGate(value, threshold)).toBe(rank <= thresholdRank);
      }
      expect(failsGate(value, "none")).toBe(false);
      expect(
        failsGate(
          { ...value, findings: [{ ...value.findings[0], baselineState: "unchanged" }] } as Report,
          "low",
        ),
      ).toBe(false);
      expect(
        failsGate(
          {
            ...value,
            findings: [{ ...value.findings[0], suppression: { reason: "reviewed" } }],
          } as Report,
          "low",
        ),
      ).toBe(false);
    }
  });

  it("matches suppression selectors conjunctively, with root-relative path globs", () => {
    const first = report.findings[0];
    if (!first) throw new Error("fixture needs findings");
    const finding = { ...first, location: { ...first.location, path: "src/nested/tool.py" } };
    for (const path of ["src/**/*.py", "**/tool.py", "src/nested/*.py"]) {
      expect(matchesSuppression({ rule: finding.rule, path, reason: "reviewed" }, finding)).toBe(
        true,
      );
    }
    expect(
      matchesSuppression({ rule: finding.rule, path: "src/*.py", reason: "reviewed" }, finding),
    ).toBe(false);
    expect(
      matchesSuppression(
        { rule: "PLG999", fingerprint: finding.fingerprint, reason: "reviewed" },
        finding,
      ),
    ).toBe(false);
    expect(
      matchesSuppression(
        { path: "**/tool.py", rule: finding.rule, reason: "reviewed" },
        { ...finding, location: { ...finding.location, path: "tool.py" } },
      ),
    ).toBe(true);
  });

  it("explains a fully suppressed terminal report and retains reasons in Markdown", () => {
    const value = createReport(report, {
      suppressions: report.rules.map((rule) => ({ rule: rule.id, reason: "Reviewed" })),
    });
    const text = formatReport(value, "terminal", { color: false });
    expect(text).toContain("All detected findings are suppressed");
    expect(text).not.toContain("No risks detected");
    expect(toMarkdown(value)).toContain("Suppressed: Reviewed");
  });

  it("strictly reads policy files and rejects configurations that could silently miss a selector", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plenger-policies-"));
    const path = join(dir, "policy.json");
    try {
      const baseline = createBaseline(report.findings);
      expect(ajv.compile(REPORT_SCHEMAS["baseline-v1.schema.json"])(baseline)).toBe(true);
      await writeFile(path, JSON.stringify(baseline));
      expect(await readBaseline(path)).toEqual(baseline);
      await writeFile(
        path,
        JSON.stringify({ ...baseline, findings: [baseline.findings[0], baseline.findings[0]] }),
      );
      await expect(readBaseline(path)).rejects.toThrow("duplicate");
      for (const suppression of [
        { rule: "PLG101", reason: "" },
        { rule: "PLG999", reason: "reviewed" },
        { path: "**", reason: "reviewed" },
        { fingerprint: "bad", reason: "reviewed" },
        { rule: "PLG101", path: "../tool.py", reason: "reviewed" },
        { rule: "PLG101", reason: "reviewed", typo: true },
      ]) {
        await writeFile(path, JSON.stringify({ schemaVersion: 1, suppressions: [suppression] }));
        await expect(readSuppressions(path)).rejects.toThrow();
      }
      await writeFile(
        path,
        JSON.stringify({
          schemaVersion: 1,
          suppressions: [{ rule: "PLG101", path: "**/*.py", reason: "Reviewed" }],
        }),
      );
      expect(await readSuppressions(path)).toEqual([
        { rule: "PLG101", path: "**/*.py", reason: "Reviewed" },
      ]);
      expect(
        ajv.compile(REPORT_SCHEMAS["suppressions-v1.schema.json"])(
          JSON.parse(await readFile(path, "utf8")),
        ),
      ).toBe(true);
      await writeFile(path, "{invalid");
      await expect(readSuppressions(path)).rejects.toThrow("invalid JSON");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
