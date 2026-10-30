import { coversAll, mergeRanges } from "../../../src/assessment/review-excerpt.ts";
import type { SecurityScan } from "../../../src/dashboard/contract.ts";

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
  };
}
