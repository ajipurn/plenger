import { parse } from "smol-toml";
import { isRecord } from "../shared/guards.ts";
import { sha256Hex } from "../shared/hash.ts";
import { redact } from "../shared/secrets.ts";
import { LLMFY_RUNTIME } from "./constants.ts";
import { decodeSource, ProjectFileError, readProjectFile } from "./project-files.ts";

export interface DependencyReview {
  status: "declared" | "needs-attention";
  /** These declarations have NOT been resolved or installed. */
  resolved: false;
  manifests: { path: string; sha256: string | null; status: string }[];
  packages: { name: string; extras: string[]; constraint: string; source: string }[];
  issues: { path: string; reason: string; line?: number }[];
  llmfy: { version: string | null; matchesSyntheticBaseline: boolean };
  requiresPython: string | null;
}

/** Declarative metadata only. No URLs, includes, markers, scripts or installers. */
export async function reviewDependencies(root: string): Promise<DependencyReview> {
  const report: DependencyReview = {
    status: "declared",
    resolved: false,
    manifests: [],
    packages: [],
    issues: [],
    llmfy: { version: null, matchesSyntheticBaseline: false },
    requiresPython: null,
  };
  const add = (value: unknown, path: string, line?: number) => {
    const item = typeof value === "string" ? requirement(value) : null;
    if (item) report.packages.push({ ...item, source: path });
    else
      report.issues.push({
        path,
        reason: "unsupported-dependency-declaration",
        ...(line === undefined ? {} : { line }),
      });
  };
  for (const path of ["pyproject.toml", "requirements.txt"]) {
    let text: string;
    let bytes: Buffer;
    try {
      bytes = await readProjectFile(root, path, 256 * 1024);
      text = decodeSource(bytes);
      if (redact(text) !== text) throw new ProjectFileError("embedded-credential");
    } catch (error) {
      const reason = error instanceof ProjectFileError ? error.reason : "unreadable";
      report.manifests.push({ path, status: reason, sha256: null });
      if (reason !== "missing") report.issues.push({ path, reason });
      continue;
    }
    report.manifests.push({
      path,
      status: "read",
      sha256: sha256Hex(bytes),
    });
    if (path === "requirements.txt") {
      for (const [index, raw] of text.split(/\r?\n/).entries()) {
        const line = raw.replace(/\s+#.*$/, "").trim();
        if (line && !line.startsWith("#")) add(line, path, index + 1);
      }
      continue;
    }
    try {
      const data = parse(text) as Record<string, unknown>;
      const project = object(data.project);
      const tool = object(data.tool);
      if (Object.keys(object(tool.poetry)).length > 0)
        report.issues.push({ path, reason: "poetry-metadata-not-supported" });
      if (
        Object.keys(object(object(tool.uv).sources)).length > 0 ||
        object(tool.uv).index !== undefined
      )
        report.issues.push({ path, reason: "custom-dependency-source-not-supported" });
      if (
        project.dynamic !== undefined &&
        (!Array.isArray(project.dynamic) || project.dynamic.includes("dependencies"))
      )
        report.issues.push({ path, reason: "dynamic-dependencies-not-supported" });
      if (Array.isArray(project.dependencies))
        for (const value of project.dependencies) add(value, path);
      else if (project.dependencies !== undefined)
        report.issues.push({ path, reason: "invalid-dependencies" });
      if (
        typeof project["requires-python"] === "string" &&
        /^[\d\s.,<>=!~*]+$/.test(project["requires-python"])
      )
        report.requiresPython = project["requires-python"];
      else if (project["requires-python"] !== undefined)
        report.issues.push({ path, reason: "unsupported-python-constraint" });
    } catch {
      // Parser diagnostics can quote credential-bearing source. Never echo them.
      report.issues.push({ path, reason: "invalid-toml" });
    }
  }
  const llmfy = report.packages.filter((item) => item.name === "llmfy");
  const pins = [
    ...new Set(
      llmfy.map((item) =>
        /^==\d+\.\d+\.\d+$/.test(item.constraint) ? item.constraint.slice(2) : null,
      ),
    ),
  ];
  if (pins.length === 1 && pins[0] !== null) report.llmfy.version = pins[0] ?? null;
  report.llmfy.matchesSyntheticBaseline = report.llmfy.version === LLMFY_RUNTIME.llmfy;
  if (llmfy.length === 0)
    report.issues.push({ path: ".", reason: "llmfy-dependency-not-declared" });
  else if (report.llmfy.version === null)
    report.issues.push({ path: ".", reason: "llmfy-version-unresolved" });
  else if (!report.llmfy.matchesSyntheticBaseline)
    report.issues.push({ path: ".", reason: "llmfy-version-not-qualified" });
  const declarations = new Map<string, string>();
  for (const item of report.packages) {
    const previous = declarations.get(item.name);
    if (previous !== undefined && previous !== item.constraint)
      report.issues.push({ path: item.source, reason: `conflicting-dependency:${item.name}` });
    declarations.set(item.name, item.constraint);
  }
  if (report.issues.length > 0) report.status = "needs-attention";
  return report;
}

function object(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function requirement(value: string): Omit<DependencyReview["packages"][number], "source"> | null {
  const match =
    /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[([A-Za-z0-9_,.-]+)\])?\s*((?:(?:===|==|!=|>=|<=|~=|>|<)\s*[\d][A-Za-z0-9.*+!-]*(?:\s*,\s*(?:==|!=|>=|<=|~=|>|<)\s*[\d][A-Za-z0-9.*+!-]*)*)?)$/.exec(
      value.trim(),
    );
  if (!match) return null;
  return {
    name: (match[1] as string).toLowerCase().replace(/[-_.]+/g, "-"),
    extras: (match[2]?.split(",") ?? []).map((item) => item.toLowerCase().replace(/[-_.]+/g, "-")),
    constraint: (match[3] ?? "").replace(/\s/g, ""),
  };
}
