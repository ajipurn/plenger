import { coversAll, mergeRanges } from "../../../src/assessment/review-excerpt.ts";
import { SCAN_DEPTHS, type SecurityScan } from "../../../src/dashboard/contract.ts";

interface FileCounts {
  total: number;
  read: number;
  partial: number;
  unread: number;
}
interface RoundCoverage extends FileCounts {
  files: number;
  newFiles: number;
  revisitedFiles: number;
}
export type SourceCoverage = ReturnType<typeof scanSourceCoverage>;

/** Accumulate observed line ranges, without changing historical scan records. */
export function scanSourceCoverage(scan: Pick<SecurityScan, "reviews" | "coverage">) {
  type File = SecurityScan["reviews"][number]["scope"]["files"][number];
  const known = new Map<
    string,
    Pick<File, "digest" | "lines"> & { ranges: NonNullable<File["ranges"]> | null }
  >();
  const rounds: RoundCoverage[] = [];
  const eligible = Math.max(
    scan.coverage?.eligibleFiles ?? 0,
    ...scan.reviews.map((review) => review.scope.eligibleFiles),
  );
  for (const review of scan.reviews) {
    // Batch validators can read related source outside the discovery context.
    const files = [...review.scope.files, ...(review.scope.related ?? [])];
    const paths = new Set(files.map((file) => file.path));
    const newFiles = [...paths].filter((path) => !known.has(path)).length;
    for (const file of files) {
      const previous = known.get(file.path);
      const sameSource = previous?.digest === file.digest && previous.lines === file.lines;
      const earlier = sameSource ? previous : undefined;
      // Never combine ranges from different versions of the same file.
      const ranges =
        !file.ranges || earlier?.ranges === null
          ? null
          : mergeRanges([...(earlier?.ranges ?? []), ...file.ranges], file.lines, 0);
      known.set(file.path, {
        digest: file.digest,
        lines: file.lines,
        ranges: ranges && !coversAll(ranges, file.lines) ? ranges : null,
      });
    }
    const read = [...known.values()].filter((file) => file.ranges === null).length;
    const total = Math.max(eligible, known.size);
    rounds.push({
      total,
      read,
      partial: known.size - read,
      unread: total - known.size,
      files: paths.size,
      newFiles,
      revisitedFiles: paths.size - newFiles,
    });
  }
  const counts: FileCounts = rounds.at(-1) ?? {
    total: eligible,
    read: 0,
    partial: 0,
    unread: eligible,
  };
  return {
    total: counts.total,
    read: counts.read,
    partial: counts.partial,
    unread: counts.unread,
    rounds,
    /** Every file a round reached, read in full or in part. */
    files: [...known].map(([path, file]) => ({ path, read: file.ranges === null })),
  };
}

/** Recent rounds set the pace, so a change of pace shows within a few rounds. */
const PACE_ROUNDS = 5;

export interface ScanPace {
  /** New files per round across the recent rounds. */
  newFiles: number;
  /** Rounds the round limit or the spending limit still allows, the current one included. */
  roundsLeft: number;
  limit: "rounds" | "spending";
  /** Rounds the unread files need at this pace; null when recent rounds reached no new file. */
  roundsNeeded: number | null;
  /** Files reached when the scan stops at this pace. */
  projected: number;
  /** Wall time of a recent round. */
  roundMs: number;
}

/**
 * Where a running Full coverage scan is heading: how many files it reaches before its
 * round limit or spending limit, at the pace of its recent rounds. An estimate only.
 */
export function scanPace(
  scan: Pick<SecurityScan, "depth" | "reviews" | "budget" | "coverage">,
  coverage: SourceCoverage,
): ScanPace | null {
  const rounds = coverage.rounds.slice(-PACE_ROUNDS);
  const reviews = scan.reviews.slice(-PACE_ROUNDS);
  if (rounds.length < 2) return null;
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const newFiles = mean(rounds.map((round) => round.newFiles));
  let roundsLeft = Math.max(0, SCAN_DEPTHS[scan.depth].batches - scan.reviews.length);
  let limit: ScanPace["limit"] = "rounds";
  const charged = scan.coverage?.charged;
  const perRound =
    scan.budget?.kind === "tokens"
      ? mean(reviews.map((review) => review.request.charged?.tokens ?? 0))
      : reviews.every((review) => typeof review.request.charged?.usd === "number")
        ? mean(reviews.map((review) => review.request.charged?.usd ?? 0))
        : null;
  const remaining = !scan.budget
    ? null
    : scan.budget.kind === "tokens"
      ? scan.budget.tokens - (charged?.tokens ?? 0)
      : typeof charged?.usd === "number"
        ? scan.budget.usd - charged.usd
        : null;
  if (perRound && remaining !== null) {
    const affordable = Math.max(0, Math.floor(remaining / perRound));
    if (affordable < roundsLeft) {
      roundsLeft = affordable;
      limit = "spending";
    }
  }
  const roundsNeeded = newFiles > 0 ? Math.ceil(coverage.unread / newFiles) : null;
  const reached = coverage.total - coverage.unread;
  return {
    newFiles,
    roundsLeft,
    limit,
    roundsNeeded,
    projected: Math.min(
      coverage.total,
      reached + Math.round(newFiles * Math.min(roundsLeft, roundsNeeded ?? roundsLeft)),
    ),
    roundMs: mean(reviews.map((review) => review.request.durationMs)),
  };
}

/** Folders listed before the grouping stops going one level deeper. */
const FOLDER_GROUPS = 12;

export interface FolderCounts {
  folder: string;
  read: number;
  partial: number;
  /** Zero when the eligible files are not known. */
  unread: number;
}

/**
 * The eligible files by folder, grouped at the deepest level that still fits in a short
 * list, most files first. Without the eligible list, only the files the rounds reached.
 */
export function folderCoverage(
  files: SourceCoverage["files"],
  eligible: readonly string[] | null = null,
): FolderCounts[] {
  const reached = new Set(files.map((file) => file.path));
  const states: { path: string; state: "read" | "partial" | "unread" }[] = [
    ...files.map((file) => ({ path: file.path, state: file.read ? "read" : "partial" }) as const),
    ...(eligible ?? [])
      .filter((path) => !reached.has(path))
      .map((path) => ({ path, state: "unread" }) as const),
  ];
  const group = (depth: number) => {
    const folders = new Map<string, FolderCounts>();
    for (const { path, state } of states) {
      const folder = path.split("/").slice(0, -1).slice(0, depth).join("/") || ".";
      const counts = folders.get(folder) ?? { folder, read: 0, partial: 0, unread: 0 };
      counts[state]++;
      folders.set(folder, counts);
    }
    return [...folders.values()];
  };
  const deepest = Math.max(1, ...states.map((file) => file.path.split("/").length - 1));
  let groups = group(1);
  for (let depth = 2; depth <= deepest; depth++) {
    const deeper = group(depth);
    if (deeper.length > FOLDER_GROUPS) break;
    groups = deeper;
  }
  const total = (counts: FolderCounts) => counts.read + counts.partial + counts.unread;
  return groups.sort((a, b) => total(b) - total(a) || a.folder.localeCompare(b.folder));
}
