import type { RuntimeVersion } from "./model.ts";

/** A vulnerability in a runtime itself, fixed in one release per supported branch. */
export interface RuntimeAdvisory {
  /** The name the advisory is known by, used in finding titles. */
  name: string;
  runtime: "php";
  cves: string[];
  /** `YYYY-MM-DD`. An image built before this day cannot hold the fix. */
  published: string;
  /**
   * The first fixed release of each supported branch, by `major.minor`. Older branches are
   * end of life and affected without a fix; newer ones are not affected.
   */
  fixed: Record<string, number>;
  /** A setting that closes the known paths until the fix is installed, and its safe value. */
  mitigation: { setting: string; enabled: boolean };
}

/** The PHP advisories of 2026-10-21: use-after-free in `session.upload_progress` handling. */
export const PHP2SHELL: RuntimeAdvisory = {
  name: "PHP2Shell",
  runtime: "php",
  cves: ["CVE-2026-109618", "CVE-2026-109619"],
  published: "2026-10-21",
  fixed: { "8.2": 35, "8.3": 36, "8.4": 27, "8.5": 12 },
  mitigation: { setting: "session.upload_progress.enabled", enabled: false },
};

/** The runtime advisories plenger checks. */
export const RUNTIME_ADVISORIES: RuntimeAdvisory[] = [PHP2SHELL];

/** The settings any advisory names as a mitigation, which the platform reader collects. */
export const MITIGATION_SETTINGS: ReadonlySet<string> = new Set(
  RUNTIME_ADVISORIES.map((advisory) => advisory.mitigation.setting),
);

/**
 * What a declared version means for an advisory. `floating` versions name a supported
 * branch or major version without the patch release, which the build decides; `fix` is
 * the fixed release of the branch when the branch is known.
 */
export type Exposure =
  | { kind: "vulnerable"; fix: string }
  | { kind: "end_of_life" }
  | { kind: "floating"; fix: string | null }
  | { kind: "unaffected" };

export function exposure(advisory: RuntimeAdvisory, version: RuntimeVersion | null): Exposure {
  if (version === null) return { kind: "floating", fix: null };
  const branches = branchesOf(advisory);
  const oldest = branches[0];
  const newest = branches.at(-1);
  if (oldest === undefined || newest === undefined) return { kind: "unaffected" };
  if (version.minor === undefined) {
    if (version.major < oldest[0]) return { kind: "end_of_life" };
    if (version.major > newest[0]) return { kind: "unaffected" };
    return { kind: "floating", fix: null };
  }
  const branch: [number, number] = [version.major, version.minor];
  if (compareBranches(branch, oldest) < 0) return { kind: "end_of_life" };
  if (compareBranches(branch, newest) > 0) return { kind: "unaffected" };
  const patch = advisory.fixed[branch.join(".")];
  if (patch === undefined) return { kind: "floating", fix: null };
  const fix = `${branch.join(".")}.${patch}`;
  if (version.patch === undefined) return { kind: "floating", fix };
  return version.patch < patch ? { kind: "vulnerable", fix } : { kind: "unaffected" };
}

/** `8`, `8.3` or `8.3.35`. */
export function versionText(version: RuntimeVersion): string {
  return [version.major, version.minor, version.patch]
    .filter((part) => part !== undefined)
    .join(".");
}

/** The fixed release of every branch, oldest first: `8.2.35`, `8.3.36`. */
export function fixedReleases(advisory: RuntimeAdvisory): string[] {
  return branchesOf(advisory).map(
    (branch) => `${branch.join(".")}.${advisory.fixed[branch.join(".")]}`,
  );
}

/** The oldest branch with a fix, `8.2`; older branches are end of life. */
export function oldestFixedBranch(advisory: RuntimeAdvisory): string {
  return branchesOf(advisory)[0]?.join(".") ?? "";
}

function branchesOf(advisory: RuntimeAdvisory): [number, number][] {
  return Object.keys(advisory.fixed)
    .map((branch) => branch.split(".").map(Number) as [number, number])
    .sort(compareBranches);
}

function compareBranches(a: [number, number], b: [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}
