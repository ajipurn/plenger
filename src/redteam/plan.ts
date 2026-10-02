import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { type CollectOptions, collectSourceFiles } from "../files.ts";
import { PLACEHOLDER, redact, redactReport } from "../secrets.ts";
import { VERSION } from "../version.ts";
import { type DependencyReview, reviewDependencies } from "./dependencies.ts";
import { type DiscoveryReport, type DiscoveryTarget, discoverProject } from "./discover.ts";
import { decodeSource, ProjectFileError, readProjectFile } from "./project-files.ts";

export class PreparationError extends Error {}

export interface ProjectPlan {
  schemaVersion: 1;
  kind: "redteam-project-plan";
  tool: { name: "plenger"; version: string };
  root: string;
  mode: "offline";
  executionReady: false;
  /** Covers captured Python bytes and reviewed manifests, not undiscovered resources. */
  sourceDigest: string;
  selectedTarget: string | null;
  selection: "automatic" | "explicit" | "required" | "unavailable";
  targets: DiscoveryTarget[];
  preparation: { status: "ready" | "blocked"; reasons: string[] };
  sources: {
    policy: "python-only-v1";
    resources: "not-collected";
    files: { path: string; bytes: number; sha256: string }[];
    omitted: { path: string; reason: string }[];
    excludedDirs: DiscoveryReport["scan"]["excludedDirs"];
    truncated: boolean;
  };
  dependencies: DependencyReview;
  pending: string[];
}

export interface PlanOptions extends CollectOptions {
  target?: string;
  maxTotalBytes?: number;
}

/** Read-only planning: the private analysis snapshot is always removed. */
export async function planProject(path: string, options: PlanOptions = {}): Promise<ProjectPlan> {
  const snapshot = await capture(path, options);
  try {
    return snapshot.plan;
  } finally {
    await snapshot.dispose();
  }
}

/**
 * Internal runner seam. Callback receives only an eligible, private source snapshot.
 * This does not authorize executing it: runtime, packs and provider access remain pending.
 * A previous plan digest prevents preparation silently using a changed project.
 */
export async function withPreparedProject<T>(
  path: string,
  options: PlanOptions & { expectedDigest?: string },
  use: (workspace: string, plan: ProjectPlan) => Promise<T>,
): Promise<T> {
  const snapshot = await capture(path, options);
  try {
    if (
      options.expectedDigest !== undefined &&
      snapshot.plan.sourceDigest !== options.expectedDigest
    )
      throw new PreparationError("Project changed since planning; create a new plan.");
    if (snapshot.plan.preparation.status !== "ready")
      throw new PreparationError(
        `Project preparation blocked: ${snapshot.plan.preparation.reasons.join(", ")}`,
      );
    return await use(snapshot.directory, snapshot.plan);
  } finally {
    await snapshot.dispose();
  }
}

async function capture(path: string, options: PlanOptions) {
  const root = await realpath(path);
  if (!(await stat(root)).isDirectory())
    throw new PreparationError("Project planning requires a directory.");
  const maxFileBytes = options.maxFileBytes ?? 1024 * 1024;
  const maxFiles = options.maxFiles ?? 2000;
  const maxTotalBytes = options.maxTotalBytes ?? 16 * 1024 * 1024;
  for (const [name, value, ceiling] of [
    ["maxFileBytes", maxFileBytes, 1024 * 1024],
    ["maxFiles", maxFiles, 2000],
    ["maxTotalBytes", maxTotalBytes, 16 * 1024 * 1024],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling)
      throw new PreparationError(`${name} must be an integer between 1 and ${ceiling}.`);
  }
  const dependencies = await reviewDependencies(root);
  const collected = await collectSourceFiles(root, { ...options, maxFileBytes, maxFiles });
  const directory = await realpath(await mkdtemp(join(tmpdir(), "plenger-project-")));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    const location = relative(root, directory);
    if (
      location === "" ||
      (!isAbsolute(location) && !location.startsWith(`..${sep}`) && location !== "..")
    )
      throw new PreparationError(
        "Project root contains the temporary workspace; select a narrower project directory.",
      );
    await chmod(directory, 0o700);
    const files: ProjectPlan["sources"]["files"] = [];
    const omitted: ProjectPlan["sources"]["omitted"] = [...collected.skipped];
    let total = 0;
    for (const file of collected.files) {
      if (file.grammar !== "python") {
        omitted.push({ path: file.path, reason: "outside-python-profile" });
        continue;
      }
      if (
        file.path
          .split("/")
          .some((part) => part.startsWith(".") || /^(?:credentials|secrets)(?:[_.-]|$)/i.test(part))
      ) {
        omitted.push({ path: file.path, reason: "sensitive-source-path" });
        continue;
      }
      try {
        const bytes = await readProjectFile(root, file.path, maxFileBytes);
        const text = decodeSource(bytes);
        if (redact(text) !== text || hasLiteralAccess(text))
          throw new ProjectFileError("embedded-credential");
        if (total + bytes.length > maxTotalBytes) throw new ProjectFileError("total-byte-limit");
        const destination = join(directory, file.path);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, bytes, { mode: 0o400, flag: "wx" });
        total += bytes.length;
        files.push({ path: file.path, bytes: bytes.length, sha256: hash(bytes) });
      } catch (error) {
        if (!(error instanceof ProjectFileError)) throw error;
        omitted.push({ path: file.path, reason: error.reason });
      }
    }
    // Discovery reads exactly the captured bytes, not a second view of the live project.
    const discovered = await discoverProject(directory, {
      gitignore: false,
      maxFiles,
      maxFileBytes,
    });
    const candidates = discovered.targets.filter((target) => target.status === "candidate");
    let selected: DiscoveryTarget | undefined;
    let selection: ProjectPlan["selection"] = candidates.length === 0 ? "unavailable" : "required";
    if (options.target !== undefined) {
      selected = candidates.find((target) => target.id === options.target);
      if (!selected)
        throw new PreparationError(
          "Selected target is absent or unsupported; choose a candidate from the current plan.",
        );
      selection = "explicit";
    } else if (candidates.length === 1) {
      selected = candidates[0];
      selection = "automatic";
    }
    const reasons: string[] = [];
    if (!selected)
      reasons.push(selection === "required" ? "target-selection-required" : "no-candidate-target");
    if (dependencies.status !== "declared") reasons.push("dependency-review-required");
    if (collected.truncated) reasons.push("source-file-limit");
    if (discovered.scan.syntaxErrors.length) reasons.push("source-syntax-errors");
    if (
      omitted.some(
        (item) =>
          !["gitignored", "outside-python-profile", "declaration", "minified"].includes(
            item.reason,
          ),
      )
    )
      reasons.push("source-preparation-gaps");
    omitted.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const plan: ProjectPlan = {
      schemaVersion: 1,
      kind: "redteam-project-plan",
      tool: { name: "plenger", version: VERSION },
      root,
      mode: "offline",
      executionReady: false,
      sourceDigest: hash(JSON.stringify({ files, manifests: dependencies.manifests })),
      selectedTarget: selected?.id ?? null,
      selection,
      targets: discovered.targets,
      preparation: { status: reasons.length ? "blocked" : "ready", reasons },
      sources: {
        policy: "python-only-v1",
        resources: "not-collected",
        files,
        omitted,
        excludedDirs: collected.excludedDirs,
        truncated: collected.truncated,
      },
      dependencies,
      pending: [
        "Qualify required data/configuration resources; the snapshot contains Python source only.",
        "Resolve and qualify dependencies, Python version and project layout; lockfiles are not resolved yet.",
        "Verify input/output mapping and bind compatible built-in test packs and effect hooks.",
        "Replace any embedded access with managed access; static secret recognition is not exhaustive.",
        "Select provider access and enforce run-wide call/token limits through the managed network path.",
        "Qualify the live-model runtime; this plan contains no executable test cases yet.",
      ],
    };
    redactReport(plan);
    return { plan, directory, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasLiteralAccess(text: string): boolean {
  const pattern =
    /\b(?:api_?key|password|passwd|secret|access_?token|auth_?token)\s*=\s*(["'])([^"'\r\n]+)\1/gi;
  return [...text.matchAll(pattern)].some((match) => !PLACEHOLDER.test(match[2] as string));
}

export function formatProjectPlan(plan: ProjectPlan): string {
  const lines = [
    `plenger ${VERSION} · offline project preparation plan`,
    plan.root,
    "",
    `Source preparation: ${plan.preparation.status}`,
    `Target selection: ${plan.selection}${plan.selectedTarget ? ` (${plan.selectedTarget})` : ""}`,
    `Captured Python sources: ${plan.sources.files.length}; omitted source entries: ${plan.sources.omitted.length}`,
    `Source digest: ${plan.sourceDigest}`,
    "",
  ];
  for (const target of plan.targets)
    lines.push(
      `${target.id}  ${target.status}  ${target.kind}  ${target.symbol ?? "(unresolved)"}  ${target.location.path}:${target.location.line}`,
    );
  lines.push("", `Dependencies: ${plan.dependencies.status}; not resolved or installed.`);
  for (const item of plan.dependencies.packages)
    lines.push(
      `  ${item.name}${item.extras.length ? `[${item.extras.join(",")}]` : ""}${item.constraint} (${item.source})`,
    );
  for (const item of plan.dependencies.issues) lines.push(`  ${item.path}: ${item.reason}`);
  for (const item of plan.sources.omitted) lines.push(`  omitted ${item.path}: ${item.reason}`);
  if (plan.preparation.reasons.length)
    lines.push("", `Needs attention: ${plan.preparation.reasons.join(", ")}`);
  lines.push(
    "",
    "Execution is unavailable; no project code was imported and no model was contacted.",
    ...plan.pending.map((item) => `  ${item}`),
  );
  return `${lines.join("\n")}\n`;
}
