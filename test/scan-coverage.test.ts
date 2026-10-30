import { describe, expect, it } from "vitest";
import { scanSourceCoverage } from "../dashboard/src/security/coverage.ts";
import type { SecurityReview } from "../src/dashboard/contract.ts";

type File = SecurityReview["scope"]["files"][number];
function file(path: string, ranges?: File["ranges"], digest = "version-one"): File {
  return { path, lines: 10, digest, ...(ranges ? { ranges } : {}) };
}
function review(files: File[], related: File[] = []): SecurityReview {
  return { scope: { files, eligibleFiles: 3, related } } as SecurityReview;
}

describe("cumulative scan source coverage", () => {
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
    expect(coverage).toEqual({ total: 42, read: 0, partial: 0, unread: 42, rounds: [] });
  });
});
