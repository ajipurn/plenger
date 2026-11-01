import { describe, expect, it } from "vitest";
import {
  folderCoverage,
  scanPace,
  scanSourceCoverage,
} from "../dashboard/src/security/coverage.ts";
import type { SecurityReview, SecurityScan } from "../src/dashboard/contract.ts";

type File = SecurityReview["scope"]["files"][number];
function file(path: string, ranges?: File["ranges"], digest = "version-one"): File {
  return { path, lines: 10, digest, ...(ranges ? { ranges } : {}) };
}
function review(files: File[], related: File[] = []): SecurityReview {
  return { status: "completed", scope: { files, eligibleFiles: 3, related } } as SecurityReview;
}

describe("cumulative scan source coverage", () => {
  it("does not count the files of a round that did not complete", () => {
    const coverage = scanSourceCoverage({
      reviews: [review([file("a.ts")]), { ...review([file("b.ts")]), status: "cancelled" }],
    });
    expect(coverage.rounds.at(-1)).toEqual({
      total: 3,
      read: 1,
      partial: 0,
      unread: 2,
      files: 1,
      newFiles: 1,
      revisitedFiles: 0,
    });
    expect(coverage.files).toEqual([{ path: "a.ts", read: true }]);
  });

  it("keeps earlier files read when later rounds read other files or no files", () => {
    const coverage = scanSourceCoverage({
      reviews: [review([file("a.ts")]), review([file("b.ts")]), review([])],
    });
    expect(coverage.rounds).toEqual([
      { total: 3, read: 1, partial: 0, unread: 2, files: 1, newFiles: 1, revisitedFiles: 0 },
      { total: 3, read: 2, partial: 0, unread: 1, files: 1, newFiles: 1, revisitedFiles: 0 },
      { total: 3, read: 2, partial: 0, unread: 1, files: 0, newFiles: 0, revisitedFiles: 0 },
    ]);
  });

  it("merges overlapping excerpts but leaves gaps partial until their lines are read", () => {
    const reviews = [
      review([file("a.ts", [{ line: 1, endLine: 5 }])]),
      review([file("a.ts", [{ line: 4, endLine: 9 }])]),
      review([file("a.ts", [{ line: 10, endLine: 10 }])]),
    ];
    const original = structuredClone(reviews);
    const coverage = scanSourceCoverage({ reviews });
    expect(coverage.rounds.map(({ read, partial, unread }) => ({ read, partial, unread }))).toEqual(
      [
        { read: 0, partial: 1, unread: 2 },
        { read: 0, partial: 1, unread: 2 },
        { read: 1, partial: 0, unread: 2 },
      ],
    );
    expect(coverage.rounds[2]).toMatchObject({ newFiles: 0, revisitedFiles: 1 });
    expect(reviews).toEqual(original);
  });

  it("does not mark an unobserved line between two excerpts as read", () => {
    expect(
      scanSourceCoverage({
        reviews: [
          review([
            file("a.ts", [
              { line: 1, endLine: 4 },
              { line: 6, endLine: 10 },
            ]),
          ]),
        ],
      }),
    ).toMatchObject({ read: 0, partial: 1, unread: 2 });
  });

  it("counts validation source once and preserves complete coverage on a partial reread", () => {
    const coverage = scanSourceCoverage({
      reviews: [
        review([file("a.ts", [{ line: 1, endLine: 4 }])], [file("a.ts"), file("b.ts")]),
        review([file("a.ts", [{ line: 2, endLine: 3 }])]),
      ],
    });
    expect(coverage.rounds[0]).toMatchObject({
      read: 2,
      partial: 0,
      unread: 1,
      files: 2,
      newFiles: 2,
    });
    expect(coverage.rounds[1]).toMatchObject({
      read: 2,
      partial: 0,
      unread: 1,
      newFiles: 0,
      revisitedFiles: 1,
    });
  });

  it("does not combine observations from different file versions", () => {
    const coverage = scanSourceCoverage({
      reviews: [
        review([file("a.ts")]),
        review([file("a.ts", [{ line: 6, endLine: 10 }], "version-two")]),
      ],
    });
    expect(coverage).toMatchObject({ read: 0, partial: 1, unread: 2 });
    expect(coverage.rounds[0]).toMatchObject({ read: 1, partial: 0 });
  });

  it("shows the eligible files as unread before the first round", () => {
    const coverage = scanSourceCoverage({
      reviews: [],
      coverage: { eligibleFiles: 42, sentFiles: 0, stop: null, charged: { tokens: 0, usd: 0 } },
    });
    expect(coverage).toEqual({
      total: 42,
      read: 0,
      partial: 0,
      unread: 42,
      rounds: [],
      files: [],
    });
  });

  it("lists each reached file once, read in full or in part", () => {
    const coverage = scanSourceCoverage({
      reviews: [review([file("a.ts"), file("b.ts", [{ line: 1, endLine: 4 }])])],
    });
    expect(coverage.files).toEqual([
      { path: "a.ts", read: true },
      { path: "b.ts", read: false },
    ]);
  });
});

describe("scan pace", () => {
  type Pace = Pick<SecurityScan, "depth" | "reviews" | "budget" | "coverage">;
  /** Rounds of two new files each, from 100 eligible files, a minute and 10,000 tokens apiece. */
  function paced(rounds: number, extra: Partial<Pace> = {}): Pace {
    const reviews = Array.from({ length: rounds }, (_, index) => ({
      status: "completed",
      scope: { files: [file(`${index}a.ts`), file(`${index}b.ts`)], eligibleFiles: 100 },
      request: { durationMs: 60_000, charged: { tokens: 10_000, usd: 0.1 } },
    })) as SecurityReview[];
    return {
      depth: "full",
      reviews,
      coverage: {
        eligibleFiles: 100,
        sentFiles: rounds * 2,
        stop: null,
        charged: { tokens: rounds * 10_000, usd: rounds * 0.1 },
      },
      ...extra,
    };
  }

  it("waits for two finished rounds before estimating", () => {
    const scan = paced(1);
    expect(scanPace(scan, scanSourceCoverage(scan))).toBeNull();
  });

  it("projects the files reached when the round limit comes first", () => {
    const scan = paced(10);
    // 20 files reached, 80 unread: 40 more rounds needed and 90 allowed.
    expect(scanPace(scan, scanSourceCoverage(scan))).toEqual({
      newFiles: 2,
      roundsLeft: 90,
      limit: "rounds",
      roundsNeeded: 40,
      projected: 100,
      roundMs: 60_000,
    });
  });

  it("names the spending limit when it allows fewer rounds than the round limit", () => {
    const scan = paced(10, { budget: { kind: "tokens", tokens: 200_000 } });
    // 100,000 tokens left buys 10 more rounds of 10,000.
    expect(scanPace(scan, scanSourceCoverage(scan))).toMatchObject({
      roundsLeft: 10,
      limit: "spending",
      projected: 40,
    });
  });

  it("does not estimate a USD limit when a round's cost is unknown", () => {
    const scan = paced(10, { budget: { kind: "usd", usd: 1.5 } });
    const unpriced = scan.reviews.at(-1);
    if (unpriced) unpriced.request.charged = { tokens: 10_000, usd: null };
    expect(scanPace(scan, scanSourceCoverage(scan))).toMatchObject({ limit: "rounds" });
  });

  it("needs no rounds count when recent rounds reached no new file", () => {
    const scan = paced(1);
    const [first] = scan.reviews;
    if (first) scan.reviews.push(...Array.from({ length: 5 }, () => structuredClone(first)));
    expect(scanPace(scan, scanSourceCoverage(scan))).toMatchObject({ roundsNeeded: null });
  });
});

describe("folder coverage", () => {
  it("goes one level deeper while the list stays short", () => {
    expect(
      folderCoverage([
        { path: "src/api/a.ts", read: true },
        { path: "src/api/b.ts", read: false },
        { path: "src/ui/c.ts", read: true },
        { path: "README.md", read: true },
      ]),
    ).toEqual([
      { folder: "src/api", read: 1, partial: 1, unread: 0 },
      { folder: ".", read: 1, partial: 0, unread: 0 },
      { folder: "src/ui", read: 1, partial: 0, unread: 0 },
    ]);
  });

  it("counts the eligible files no round reached in their folders", () => {
    expect(
      folderCoverage(
        [{ path: "src/api/a.ts", read: true }],
        ["src/api/a.ts", "src/api/b.ts", "docs/guide.md", "docs/setup.md", "docs/faq.md"],
      ),
    ).toEqual([
      { folder: "docs", read: 0, partial: 0, unread: 3 },
      { folder: "src/api", read: 1, partial: 0, unread: 1 },
    ]);
  });

  it("stops at the last level that fits", () => {
    const files = Array.from({ length: 13 }, (_, index) => ({
      path: `src/${index}/file.ts`,
      read: true,
    }));
    expect(folderCoverage(files)).toEqual([{ folder: "src", read: 13, partial: 0, unread: 0 }]);
  });
});
