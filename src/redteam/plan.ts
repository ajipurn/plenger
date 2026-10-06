import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { compareStrings } from "../shared/compare.ts";
import { sha256Hex } from "../shared/hash.ts";
import { VERSION } from "../shared/runtime.ts";
import { redact, redactReport } from "../shared/secrets.ts";
import { collectSourceFiles } from "../source/files.ts";
import {
  FASTAPI_LLMFY_ADAPTERS,
  FASTAPI_PROFILE,
  FASTAPI_RESOURCE_EXTENSIONS,
} from "./constants.ts";
import { type DependencyReview, reviewDependencies } from "./dependencies.ts";
import { type DiscoveryReport, type DiscoveryTarget, discoverProject } from "./discover.ts";
import {
  type FastapiProfile,
  type PlanOptions,
  PreparationError,
  type ProjectPlan,
  type ProjectSnapshot,
} from "./plan-model.ts";
import {
  decodeSource,
  hasLiteralAccess,
  isSensitiveSourcePath,
  ProjectFileError,
  readProjectFile,
} from "./project-files.ts";
import { captureNextProject } from "./vercel-plan.ts";

export { formatProjectPlan } from "./format.ts";
export type { FastapiProfile, NextProfile, PlanOptions, ProjectPlan } from "./plan-model.ts";
export { PreparationError } from "./plan-model.ts";

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

async function capture(path: string, options: PlanOptions): Promise<ProjectSnapshot> {
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
  const staticDiscovery = await discoverProject(root, options);
  if (
    staticDiscovery.coverage.frameworks.some((item) => item.id === "vercel-ai") &&
    (!staticDiscovery.targets.some((item) => item.status === "candidate") ||
      options.target?.startsWith("next:"))
  )
    return captureNextProject(root, options, staticDiscovery.coverage);
  const dependencies = await reviewDependencies(root);
  const collected = await collectSourceFiles(root, {
    ...options,
    maxFileBytes,
    maxFiles,
    resources: FASTAPI_RESOURCE_EXTENSIONS,
  });
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
      if (isSensitiveSourcePath(file.path)) {
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
        files.push({ path: file.path, bytes: bytes.length, sha256: sha256Hex(bytes) });
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
    const fastapi = fastapiPlanning(discovered, dependencies, options, files);
    if (fastapi) {
      // Prompts, templates and data the application reads at import, under its own packages only.
      // Every directory holding captured Python, with its ancestors; `.` when a module
      // sits at the root, so a flat project keeps the resources beside it.
      const packages = new Set<string>();
      for (const file of files)
        for (let dir = dirname(file.path); ; dir = dirname(dir)) {
          packages.add(dir);
          if (dir === "." || dirname(dir) === ".") break;
        }
      for (const resource of collected.resources) {
        let dir = dirname(resource.path);
        while (dir !== "." && !packages.has(dir)) dir = dirname(dir);
        if (!packages.has(dir)) continue;
        if (isSensitiveSourcePath(resource.path)) {
          omitted.push({ path: resource.path, reason: "sensitive-source-path" });
          continue;
        }
        try {
          const bytes = await readProjectFile(root, resource.path, maxFileBytes);
          const text = decodeSource(bytes);
          if (redact(text) !== text || hasLiteralAccess(text))
            throw new ProjectFileError("embedded-credential");
          if (total + bytes.length > maxTotalBytes) throw new ProjectFileError("total-byte-limit");
          const destination = join(directory, resource.path);
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          await writeFile(destination, bytes, { mode: 0o400, flag: "wx" });
          total += bytes.length;
          files.push({ path: resource.path, bytes: bytes.length, sha256: sha256Hex(bytes) });
        } catch (error) {
          if (!(error instanceof ProjectFileError)) throw error;
          omitted.push({ path: resource.path, reason: error.reason });
        }
      }
      files.sort((a, b) => compareStrings(a.path, b.path));
    }
    let selected: DiscoveryTarget | undefined;
    let selection: ProjectPlan["selection"];
    const reasons: string[] = [];
    let review = dependencies;
    if (fastapi) {
      ({ selected, selection } = fastapi);
      reasons.push(...fastapi.reasons);
      review = fastapi.dependencies;
    } else {
      selection = candidates.length === 0 ? "unavailable" : "required";
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
      if (!selected)
        reasons.push(
          selection === "required" ? "target-selection-required" : "no-candidate-target",
        );
      if (dependencies.status !== "declared") reasons.push("dependency-review-required");
    }
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
    omitted.sort((a, b) => compareStrings(a.path, b.path));
    const plan: ProjectPlan = {
      schemaVersion: 1,
      kind: "redteam-project-plan",
      tool: { name: "plenger", version: VERSION },
      root,
      mode: "offline",
      executionReady: false,
      sourceDigest: sha256Hex(JSON.stringify({ files, manifests: dependencies.manifests })),
      selectedTarget: selected?.id ?? null,
      selection,
      targets: fastapi ? [...discovered.targets, ...fastapi.targets] : discovered.targets,
      coverage: staticDiscovery.coverage,
      preparation: { status: reasons.length ? "blocked" : "ready", reasons },
      sources: {
        policy: fastapi ? "python-resources-v1" : "python-only-v1",
        resources: "not-collected",
        files,
        omitted,
        excludedDirs: collected.excludedDirs,
        truncated: collected.truncated,
      },
      dependencies: review,
      ...(fastapi ? { fastapiProfile: fastapi.profile } : {}),
      pending: fastapi
        ? [
            "Dependencies are resolved and installed in the build stage; the preparation report records the result.",
            "The application imports beside disposable MySQL and Redis services; other services need recording doubles.",
            "Model classes are replaced by the host broker; no case pack delivers attacks through this profile yet.",
          ]
        : [
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

interface FastapiPlanning {
  targets: DiscoveryTarget[];
  selected: DiscoveryTarget | undefined;
  selection: ProjectPlan["selection"];
  reasons: string[];
  dependencies: DependencyReview;
  profile: FastapiProfile;
}

/**
 * The FastAPI project profile applies to a project that declares llmfy and assigns a
 * FastAPI application at module level, unless the file-canary profile can bind one
 * of its llmfy entry points or an llmfy target was selected explicitly.
 */
function fastapiPlanning(
  discovered: DiscoveryReport,
  dependencies: DependencyReview,
  options: PlanOptions,
  files: ProjectPlan["sources"]["files"],
): FastapiPlanning | null {
  const apps = discovered.coverage.apps ?? [];
  const declaresLlmfy = dependencies.packages.some((item) => item.name === "llmfy");
  const bound = discovered.targets.some(
    (target) =>
      target.status === "candidate" && target.packs.some((pack) => pack.status === "bound"),
  );
  const explicit = options.target?.startsWith("fastapi:") ?? false;
  if (apps.length === 0 || !declaresLlmfy || (!explicit && (bound || options.target !== undefined)))
    return null;
  const captured = new Set(files.map((file) => file.path));
  const targets: DiscoveryTarget[] = apps.map((app) => {
    const reasons: string[] = [];
    if (!captured.has(app.location.path)) reasons.push("app-source-not-captured");
    if (discovered.scan.syntaxErrors.includes(app.location.path))
      reasons.push("source-has-syntax-errors");
    return {
      id: `fastapi:${sha256Hex(`${app.location.path}:${app.attribute}`, 16)}`,
      framework: "fastapi",
      kind: "app",
      location: app.location,
      symbol: `${app.module}:${app.attribute}`,
      async: true,
      parameters: [],
      status: reasons.length ? "unsupported" : "candidate",
      reasons,
      agentIds: [],
      evidence: [],
      packs: [],
    };
  });
  const candidates = targets.filter((target) => target.status === "candidate");
  let selected: DiscoveryTarget | undefined;
  let selection: ProjectPlan["selection"] = candidates.length === 0 ? "unavailable" : "required";
  if (options.target !== undefined) {
    selected = candidates.find((target) => target.id === options.target);
    if (!selected)
      throw new PreparationError(
        "Selected application is absent or unsupported; choose one from the current plan.",
      );
    selection = "explicit";
  } else if (candidates.length === 1) {
    selected = candidates[0];
    selection = "automatic";
  }
  const reasons: string[] = [];
  if (!selected)
    reasons.push(selection === "required" ? "target-selection-required" : "no-candidate-target");
  const version = dependencies.llmfy.version;
  const adapter =
    version !== null && FASTAPI_LLMFY_ADAPTERS.includes(version) ? "available" : "missing";
  if (adapter === "missing" && version !== null) reasons.push(`llmfy-adapter-missing:${version}`);
  // The synthetic baseline belongs to the file-canary profile; this profile needs an adapter.
  const issues = dependencies.issues.filter(
    (issue) => issue.reason !== "llmfy-version-not-qualified",
  );
  if (issues.length) reasons.push("dependency-review-required");
  const manifest = dependencies.manifests.some(
    (item) => item.path === "requirements.txt" && item.status === "read",
  )
    ? "requirements.txt"
    : null;
  if (manifest === null) reasons.push("requirements-file-required");
  const chosen = (selected ?? targets[0])?.location;
  const app =
    (chosen &&
      apps.find(
        (item) => item.location.path === chosen.path && item.location.line === chosen.line,
      )) ??
    apps[0];
  if (!app) return null;
  return {
    targets,
    selected,
    selection,
    reasons,
    dependencies: {
      ...dependencies,
      issues,
      status: issues.length ? "needs-attention" : "declared",
    },
    profile: {
      id: FASTAPI_PROFILE,
      app: { path: app.location.path, module: app.module, attribute: app.attribute },
      llmfy: { version, adapter },
      dependencies: {
        manifest,
        declared: dependencies.packages.length,
        unpinned: [
          ...new Set(
            dependencies.packages
              .filter((item) => !/^==/.test(item.constraint))
              .map((item) => item.name),
          ),
        ],
        policy: "resolve-and-record",
      },
      services: ["mysql", "redis"],
      transport: "asgi-in-process",
    },
  };
}
