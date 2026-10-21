import { describe, expect, it } from "vitest";
import {
  parseReviewDiscovery,
  SECURITY_REVIEW_LIMITS,
  type TracedPath,
} from "../src/assessment/review-model.ts";
import { pathsForReview, tracedPaths } from "../src/assessment/review-paths.ts";
import { reviewProject } from "../src/assessment/security-review.ts";
import { scan } from "../src/scan.ts";
import { required } from "./support/dashboard.ts";
import { fixturePath } from "./support/fixtures.ts";
import { nativeReviewReply, reviewDecision, reviewDiscovery } from "./support/security-review.ts";

const access = {
  provider: "anthropic" as const,
  model: "claude-paths-test",
  apiKey: "paths-provider-secret-4Qm8",
  maxOutputTokens: 8192,
};
const provider = { id: "saved-provider", name: "Claude paths", model: access.model };

/** A discovery reply for the SQL tool fixture, closing its paths with `paths`. */
function sqlDiscovery(paths: unknown[]) {
  const base = reviewDiscovery();
  const finding = required(base.findings[0], "finding");
  return {
    ...base,
    stride: base.stride.map((entry) => ({
      ...entry,
      status: "insufficient-context",
      evidence: [],
    })),
    findings: [
      {
        ...finding,
        title: "Order search builds SQL from the model's text",
        cwe: "CWE-89",
        evidence: [{ path: "tools.py", line: 11, endLine: 11, role: "sink", message: "SQL text." }],
      },
    ],
    paths,
  };
}

describe("traced paths", () => {
  it("lists entry points, tools, agents and model output that reach an effect, with stable ids", async () => {
    const tool = tracedPaths((await scan(fixturePath("evaluation/py-sql-tool"))).inventory);
    expect(tool).toEqual([
      {
        id: "path-1",
        kind: "tool",
        label: "find_orders",
        at: { path: "tools.py", line: 9 },
        effects: [{ kind: "database", path: "tools.py", line: 11 }],
      },
    ]);
    const routes = tracedPaths(
      (await scan(fixturePath("evaluation/ts-exports-mount-no-role"))).inventory,
    );
    expect(routes.length).toBeGreaterThan(SECURITY_REVIEW_LIMITS.paths);
    expect(routes.map((path) => path.id)).toEqual(routes.map((_, index) => `path-${index + 1}`));
    expect(routes.every((path) => path.kind === "entry-point" && path.effects.length)).toBe(true);
    expect(routes.every((path) => path.effects.length <= SECURITY_REVIEW_LIMITS.pathEffects)).toBe(
      true,
    );
  });

  it("gives a review the paths starting in its files, skipping files an earlier review read whole", () => {
    const paths: TracedPath[] = Array.from({ length: 20 }, (_, index) => ({
      id: `path-${index + 1}`,
      kind: "entry-point",
      label: `GET /${index}`,
      at: { path: index < 18 ? "routes.ts" : "admin.ts", line: index + 1 },
      effects: [],
    }));
    const batch = pathsForReview(paths, new Set(["routes.ts"]), new Set());
    expect(batch.paths.map((path) => path.id)).toEqual(
      paths.slice(0, SECURITY_REVIEW_LIMITS.paths).map((path) => path.id),
    );
    expect(batch.left).toBe(18 - SECURITY_REVIEW_LIMITS.paths);
    // An exploring review may read any file; one read whole earlier is skipped.
    expect(pathsForReview(paths, null, new Set(["routes.ts"]))).toEqual({
      paths: paths.slice(18),
      left: 0,
    });
  });
});

describe("path closures", () => {
  const files = [{ path: "tools.py", lines: 12, digest: "" }];
  const guard = { path: "tools.py", line: 11, endLine: 11, role: "guard", message: "Checked." };
  const closure = (id: string, fields: Record<string, unknown>) => ({
    id,
    closure: "open",
    finding: null,
    reason: `Closure ${id}.`,
    evidence: [],
    ...fields,
  });

  it("keeps the closures that check out and drops the rest without failing the review", () => {
    const discovery = parseReviewDiscovery(
      JSON.stringify(
        sqlDiscovery([
          closure("path-1", { closure: "finding", finding: 0 }),
          // Repeated, unknown and out-of-range closures are dropped.
          closure("path-1", { closure: "open" }),
          closure("path-9", { closure: "open" }),
          closure("path-2", { closure: "finding", finding: 3 }),
          // A safe closure must cite lines the review received.
          closure("path-3", { closure: "safe", evidence: [] }),
          closure("path-4", { closure: "safe", evidence: [{ ...guard, path: "other.py" }] }),
          closure("path-5", { closure: "safe", evidence: [guard] }),
          // A reply without the optional fields, as a model without structured output sends.
          { id: "path-6", closure: "open", reason: "The caller is not in the batch." },
        ]),
      ),
      files,
      ["path-1", "path-2", "path-3", "path-4", "path-5", "path-6"],
    );
    expect(discovery.closures).toEqual([
      { id: "path-1", closure: "finding", finding: 0, reason: "Closure path-1.", evidence: [] },
      {
        id: "path-5",
        closure: "safe",
        reason: "Closure path-5.",
        evidence: [{ ...guard, role: "guard" }],
      },
      { id: "path-6", closure: "open", reason: "The caller is not in the batch.", evidence: [] },
    ]);
    // A long reason is cut to one short sentence instead of failing the review.
    const long = parseReviewDiscovery(
      JSON.stringify(
        sqlDiscovery([closure("path-1", { reason: "The caller is unknown. ".repeat(30) })]),
      ),
      files,
      ["path-1"],
    );
    const reason = long.closures[0]?.reason ?? "";
    expect(reason.length).toBeLessThanOrEqual(SECURITY_REVIEW_LIMITS.closureText);
    expect(reason.endsWith("(cut at the review's text limit)")).toBe(true);
    // Earlier replies and reviews without traced paths carry no paths field.
    const { paths: _paths, ...plain } = sqlDiscovery([]);
    expect(parseReviewDiscovery(JSON.stringify(plain), files).closures).toEqual([]);
    expect(() =>
      parseReviewDiscovery(
        JSON.stringify(sqlDiscovery([closure("path-1", { closure: "proven" })])),
        files,
        ["path-1"],
      ),
    ).toThrow(/\$\.paths\[0\]\.closure: unknown enum value/);
  });

  it("sends a batch its traced paths and saves each with its closure and candidate", async () => {
    const snapshot = await scan(fixturePath("evaluation/py-sql-tool"));
    const bodies: Record<string, unknown>[] = [];
    const reply = (close: boolean): typeof fetch => {
      return async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        const messages = body.messages as { content: { text: string }[] }[];
        const data = JSON.parse(messages[0]?.content[0]?.text ?? "{}");
        const content = data.candidates
          ? reviewDecision(data.candidates.map((item: { id: string }) => item.id))
          : sqlDiscovery(
              close
                ? data.tracedPaths.map((path: { id: string }) =>
                    closure(path.id, { closure: "finding", finding: 0 }),
                  )
                : [],
            );
        return new Response(JSON.stringify(nativeReviewReply(content)));
      };
    };
    const review = await reviewProject(snapshot, { scanId: "scan", provider, access }, reply(true));
    expect(review.status, review.reason ?? "").toBe("completed");
    const messages = required(bodies[0], "discovery request").messages as {
      content: { text: string }[];
    }[];
    const first = JSON.parse(messages[0]?.content[0]?.text ?? "{}");
    expect(first.tracedPaths).toEqual([
      {
        id: "path-1",
        kind: "tool",
        label: "find_orders",
        at: "tools.py:9",
        effects: ["database at tools.py:11"],
      },
    ]);
    // The second review gets candidates, not the paths.
    expect(JSON.stringify(bodies[1])).not.toContain("tracedPaths");
    expect(review.paths).toEqual([
      {
        id: "path-1",
        kind: "tool",
        label: "find_orders",
        at: { path: "tools.py", line: 9 },
        effects: [{ kind: "database", path: "tools.py", line: 11 }],
        closure: "finding",
        findingId: required(review.findings[0], "finding").id,
        reason: "Closure path-1.",
        evidence: [],
      },
    ]);
    const unclosed = await reviewProject(
      snapshot,
      { scanId: "scan", provider, access },
      reply(false),
    );
    expect(unclosed.paths?.map((path) => path.closure)).toEqual(["unclosed"]);
    expect(unclosed.limitations).toContain(
      "1 of 1 traced paths were not closed: discovery gave no closure the host could check.",
    );
  });
});
