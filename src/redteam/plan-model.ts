import type { CollectOptions } from "../source/files.ts";
import type { DependencyReview } from "./dependencies.ts";
import type { DiscoveryReport, DiscoveryTarget, StaticCoverage } from "./discover.ts";

/** Planning could not proceed; the user can fix the selection or project (exit code 2). */
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
    policy: "python-only-v1" | "next-route-sqlite-v1";
    resources: "not-collected";
    files: { path: string; bytes: number; sha256: string }[];
    omitted: { path: string; reason: string }[];
    excludedDirs: DiscoveryReport["scan"]["excludedDirs"];
    truncated: boolean;
  };
  dependencies: DependencyReview;
  pending: string[];
  /** Separate static review of the original project; not part of the runtime snapshot digest. */
  coverage?: StaticCoverage;
  nextProfile?: NextProfile;
}

export interface PlanOptions extends CollectOptions {
  target?: string;
  maxTotalBytes?: number;
}

/** The managed Next.js route profile a plan was prepared for. */
export interface NextProfile {
  id: "vercel-booking-sqlite-v1";
  route: string;
  storeModule: string;
  method: "POST";
  /** Qualified dependencies replace only provider access, not project authorization logic. */
  versions: Record<string, string>;
  resource: "disposable-sqlite";
  transport: "route-handler";
}

/** A captured private snapshot of eligible project source, removed by `dispose`. */
export interface ProjectSnapshot {
  plan: ProjectPlan;
  directory: string;
  dispose: () => Promise<void>;
}
