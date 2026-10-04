import { describe, expect, it } from "vitest";
import { looksMinified } from "../src/source/read.ts";

describe("looksMinified", () => {
  it("flags large single-line bundles", () => {
    expect(looksMinified(`var a=1;`.repeat(400))).toBe(true);
  });

  it("keeps ordinary source, however long", () => {
    const source = "export const answer = 42;\n".repeat(400);
    expect(looksMinified(source)).toBe(false);
  });

  it("keeps small files with one long line", () => {
    expect(looksMinified(`const prompt = "${"x".repeat(1500)}";\n`)).toBe(false);
  });
});
