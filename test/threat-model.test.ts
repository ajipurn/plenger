import { describe, expect, it } from "vitest";
import { extendThreatModel } from "../src/security/threat-model.ts";

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
