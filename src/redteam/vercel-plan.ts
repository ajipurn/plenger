import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { compareStrings } from "../shared/compare.ts";
import { sha256Hex } from "../shared/hash.ts";
import { VERSION } from "../shared/runtime.ts";
import { redact } from "../shared/secrets.ts";
import { SOURCE_BYTE_CAP, VERCEL_PACKAGES } from "./constants.ts";
import type { StaticCoverage } from "./discover.ts";
import {
  type NextProfile,
  type PlanOptions,
  PreparationError,
  type ProjectPlan,
  type ProjectSnapshot,
} from "./plan-model.ts";
import {
  decodeSource,
  hasLiteralAccess,
  isSensitiveSourcePath,
  readProjectFile,
} from "./project-files.ts";

export type { NextProfile };

const packages = new Set([
  ...Object.keys(VERCEL_PACKAGES),
  "@ai-sdk/google",
  "@ai-sdk/google-vertex",
]);
const builtins = new Set([
  "node:crypto",
  "crypto",
  "node:path",
  "path",
  "node:fs",
  "fs",
  "node:fs/promises",
  "fs/promises",
]);
const requiredTools = [
  "book_appointment",
  "create_invoice",
  "update_invoice_amount",
  "create_payment",
];

/** Capture only the selected handler's static import closure; never .env, databases or scripts. */
export async function captureNextProject(
  root: string,
  options: PlanOptions,
  coverage: StaticCoverage,
): Promise<ProjectSnapshot> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "plenger-next-")));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    if (directory === root || directory.startsWith(`${root}/`))
      throw new PreparationError("Choose a narrower project folder.");
    await chmod(directory, 0o700);
    const routes = coverage.httpEntryPoints.filter(
      (item) => item.framework === "nextjs" && item.method === "POST" && item.toolUsing,
    );
    const targets: ProjectPlan["targets"] = routes.map((entry) => ({
      id: `next:${sha256Hex(entry.location.path, 16)}`,
      framework: "vercel-ai",
      kind: "route",
      location: entry.location,
      symbol: `POST ${entry.path ?? entry.location.path}`,
      async: true,
      parameters: ["request"],
      status: "candidate",
      reasons: [],
      agentIds: [],
      evidence: [],
      // The booking profile binds to the route's store module in `nextProfile`, not to a pack.
      packs: [],
    }));
    const selected = options.target
      ? targets.find((item) => item.id === options.target)
      : targets.length === 1
        ? targets[0]
        : undefined;
    if (options.target && !selected)
      throw new PreparationError("Select a Next.js route from the current plan.");
    const reasons: string[] = [];
    const files: ProjectPlan["sources"]["files"] = [];
    const omitted: ProjectPlan["sources"]["omitted"] = [];
    let manifestHash: string | null = null;
    let total = 0;
    const maxTotalBytes = options.maxTotalBytes ?? SOURCE_BYTE_CAP;
    const maxFileBytes = options.maxFileBytes ?? 1024 * 1024;
    try {
      const bytes = await readProjectFile(root, "package.json", 256 * 1024);
      const manifest = JSON.parse(decodeSource(bytes));
      manifestHash = sha256Hex(bytes);
      for (const [name, version] of Object.entries(VERCEL_PACKAGES)) {
        if (name === "zod" && !manifest.dependencies?.zod) continue; // AI SDK's peer; supplied by the managed profile.
        if (![version, `^${version}`, `~${version}`].includes(manifest.dependencies?.[name]))
          reasons.push(`unsupported-version:${name}`);
      }
    } catch {
      reasons.push("package-review-required");
    }
    if (!selected)
      reasons.push(targets.length ? "target-selection-required" : "no-candidate-target");
    const texts = new Map<string, string>();
    const load = async (path: string) => {
      if (texts.has(path)) return;
      if (files.length >= 100 || total > maxTotalBytes) throw new Error("source-limit");
      if (isSensitiveSourcePath(path)) throw new Error("sensitive-source-path");
      const bytes = await readProjectFile(root, path, maxFileBytes);
      const text = decodeSource(bytes);
      if (redact(text) !== text || hasLiteralAccess(text)) throw new Error("embedded-credential");
      total += bytes.length;
      if (total > maxTotalBytes) throw new Error("source-limit");
      texts.set(path, text);
      files.push({ path, bytes: bytes.length, sha256: sha256Hex(bytes) });
      await mkdir(dirname(join(directory, path)), { recursive: true, mode: 0o700 });
      await writeFile(join(directory, path), bytes, { mode: 0o400, flag: "wx" });
      // Dynamic imports/requires need a separate qualified profile. The bundler also enforces this closure.
      if (/\b(?:import|require)\s*\(/.test(text)) throw new Error("dynamic-import-unsupported");
      const imports = [
        ...text.matchAll(/\b(?:import|export)\s+(?:[^;]*?\s+from\s*)?["']([^"']+)["']/g),
      ].map((m) => m[1] as string);
      for (const specifier of imports) {
        if (packages.has(specifier) || builtins.has(specifier)) continue;
        if (
          !specifier.startsWith("./") &&
          !specifier.startsWith("../") &&
          !specifier.startsWith("@/")
        )
          throw new Error(`unsupported-import:${specifier}`);
        const base = posix.normalize(
          specifier.startsWith("@/")
            ? specifier.slice(2)
            : posix.join(posix.dirname(path), specifier),
        );
        if (base.startsWith("../") || base === "..") throw new Error("import-outside-project");
        let resolved: string | undefined;
        for (const extension of ["", ".ts", ".js", ".mts", ".mjs", "/index.ts", "/index.js"]) {
          const candidate = `${base}${extension}`;
          if (!/\.(?:[cm]?[jt]s)$/.test(candidate)) continue;
          try {
            await readProjectFile(root, candidate, maxFileBytes);
            resolved = candidate;
            break;
          } catch {
            /* try next source extension */
          }
        }
        if (!resolved) throw new Error(`missing-import:${base}`);
        await load(resolved);
      }
    };
    if (selected) {
      try {
        await load(selected.location.path);
        const route = texts.get(selected.location.path) ?? "";
        if (!requiredTools.every((name) => new RegExp(`\\b${name}\\s*:`).test(route)))
          reasons.push("booking-tool-contract-required");
        if (
          ![...texts.values()].some(
            (text) => /better-sqlite3/.test(text) && /CREATE TABLE/.test(text),
          )
        )
          reasons.push("sqlite-schema-required");
      } catch (error) {
        const reason = error instanceof Error ? error.message : "source-preparation-gap";
        reasons.push(reason);
        omitted.push({ path: selected.location.path, reason });
      }
    }
    files.sort((a, b) => compareStrings(a.path, b.path));
    if (selected && reasons.length) {
      selected.status = "unsupported";
      selected.reasons = [...reasons];
    }
    const plan: ProjectPlan = {
      schemaVersion: 1,
      kind: "redteam-project-plan",
      tool: { name: "plenger", version: VERSION },
      root,
      mode: "offline",
      executionReady: false,
      sourceDigest: sha256Hex(JSON.stringify({ files, manifestHash })),
      selectedTarget: selected?.id ?? null,
      selection: options.target
        ? "explicit"
        : selected
          ? "automatic"
          : targets.length
            ? "required"
            : "unavailable",
      targets,
      preparation: { status: reasons.length ? "blocked" : "ready", reasons },
      sources: {
        policy: "next-route-sqlite-v1",
        resources: "not-collected",
        files,
        omitted,
        excludedDirs: [],
        truncated: false,
      },
      dependencies: {
        status: reasons.some((r) => r.includes("version") || r.includes("package"))
          ? "needs-attention"
          : "declared",
        resolved: false,
        manifests: [
          {
            path: "package.json",
            status: manifestHash ? "reviewed" : "missing",
            sha256: manifestHash,
          },
        ],
        packages: Object.entries(VERCEL_PACKAGES).map(([name, version]) => ({
          name,
          extras: [],
          constraint: `==${version}`,
          source: "managed-runtime",
        })),
        issues: [],
        llmfy: { version: null, matchesSyntheticBaseline: false },
        requiresPython: null,
      },
      nextProfile: {
        id: "vercel-booking-sqlite-v1",
        route: selected?.location.path ?? "",
        storeModule:
          [...texts.entries()].find(
            ([, text]) => /better-sqlite3/.test(text) && /CREATE TABLE/.test(text),
          )?.[0] ?? "",
        method: "POST",
        versions: VERCEL_PACKAGES,
        resource: "disposable-sqlite",
        transport: "route-handler",
      },
      coverage,
      pending: [
        "Model access is supplied for each run; project credentials are not collected.",
        "The original POST handler runs with a disposable SQLite database; Next.js server middleware is outside this profile.",
        "The booking/SQLite profile has limited live-model evidence; broader model and platform qualification remains pending.",
      ],
    };
    return { plan, directory, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
