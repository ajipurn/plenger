import { describe, expect, it } from "vitest";
import { guideDigests, REVIEW_GUIDES, selectGuides } from "../src/assessment/review-guides.ts";
import { SECURITY_REVIEW_LIMITS } from "../src/assessment/review-model.ts";
import { reviewProject } from "../src/assessment/security-review.ts";
import { FRAMEWORKS } from "../src/inventory/frameworks.ts";
import type { Inventory } from "../src/inventory/model.ts";
import { scan } from "../src/scan.ts";
import { extendThreatModel } from "../src/security/threat-model.ts";
import { fixturePath } from "./support/fixtures.ts";
import { nativeReviewReply, reviewDecision, reviewDiscovery } from "./support/security-review.ts";

const access = {
  provider: "anthropic" as const,
  model: "claude-guides-test",
  apiKey: "guides-provider-secret-8Rt3",
  maxOutputTokens: 8192,
};
const provider = { id: "saved-provider", name: "Claude guides", model: access.model };
const inventory = (...ids: string[]) =>
  ({ frameworks: ids.map((id) => ({ id, name: id, files: [] })) }) as unknown as Inventory;

describe("framework review guides", () => {
  it("covers only frameworks the inventory knows, each guide short enough to combine", () => {
    const known = new Set(FRAMEWORKS.map((framework) => framework.id));
    for (const guide of REVIEW_GUIDES) {
      for (const framework of guide.frameworks) expect(known, guide.id).toContain(framework);
      expect(Buffer.byteLength(guide.text), guide.id).toBeLessThanOrEqual(1024);
    }
    expect(new Set(REVIEW_GUIDES.map((guide) => guide.id)).size).toBe(REVIEW_GUIDES.length);
  });

  it("selects guides from the inventory in guide order, within the byte limit", () => {
    expect(selectGuides(inventory("mcp", "fastapi")).map((guide) => guide.id)).toEqual([
      "fastapi",
      "mcp",
    ]);
    expect(selectGuides(inventory("starlette")).map((guide) => guide.id)).toEqual(["fastapi"]);
    expect(selectGuides(inventory("sqlite"))).toEqual([]);
    const all = selectGuides(inventory(...FRAMEWORKS.map((framework) => framework.id)));
    const bytes = all.reduce((sum, guide) => sum + Buffer.byteLength(guide.text), 0);
    expect(bytes).toBeLessThanOrEqual(SECURITY_REVIEW_LIMITS.guideBytes);
    expect(all.length).toBeGreaterThan(2);
    expect(guideDigests(all.slice(0, 1))).toEqual([
      { id: all[0]?.id, digest: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
  });

  it("sends the guides with both requests and records their digests", async () => {
    const snapshot = await scan(fixturePath("evaluation/py-sql-tool"));
    const messages: Record<string, unknown>[] = [];
    const dispatch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const data = JSON.parse(
        (body.messages as { content: { text: string }[] }[])[0]?.content[0]?.text ?? "{}",
      );
      messages.push(data);
      const discovery = reviewDiscovery();
      const finding = discovery.findings[0];
      if (!finding) throw new Error("Missing finding fixture.");
      const content = data.candidates
        ? reviewDecision(data.candidates.map((item: { id: string }) => item.id))
        : {
            ...discovery,
            stride: discovery.stride.map((entry) => ({
              ...entry,
              status: "insufficient-context",
              evidence: [],
            })),
            findings: [
              {
                ...finding,
                evidence: [
                  { path: "tools.py", line: 11, endLine: 11, role: "sink", message: "SQL." },
                ],
              },
            ],
          };
      return new Response(JSON.stringify(nativeReviewReply(content)));
    };
    const review = await reviewProject(snapshot, { scanId: "scan", provider, access }, dispatch);
    expect(review.status, review.reason ?? "").toBe("completed");
    const langchain = required(REVIEW_GUIDES.find((guide) => guide.id === "langchain"));
    for (const data of messages)
      expect(data.frameworkGuides).toEqual([{ id: "langchain", guide: langchain.text }]);
    expect(review.generation?.guides).toEqual(guideDigests([langchain]));
  });
});

describe("project threat model", () => {
  it("lets a review extend the model, merging lists without repeats within the limits", () => {
    const model = {
      architecture: "A web app.",
      assets: ["Invoices"],
      trustBoundaries: ["Browser"],
    };
    expect(
      extendThreatModel(model, {
        architecture: "A web app with a worker queue.",
        assets: ["invoices", "Payment tokens", " "],
        trustBoundaries: ["Worker queue"],
      }),
    ).toEqual({
      architecture: "A web app with a worker queue.",
      assets: ["Invoices", "Payment tokens"],
      trustBoundaries: ["Browser", "Worker queue"],
    });
    // A review without an architecture keeps the model's; the first review starts one.
    expect(
      extendThreatModel(model, { architecture: " ", assets: [], trustBoundaries: [] }),
    ).toEqual(model);
    const many = Array.from({ length: 20 }, (_, index) => `Asset ${index}`);
    expect(
      extendThreatModel(null, { architecture: "x", assets: many, trustBoundaries: [] }).assets,
    ).toHaveLength(12);
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing fixture value");
  return value;
}
