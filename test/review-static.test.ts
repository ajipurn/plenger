import { describe, expect, it } from "vitest";
import type { ReviewCitation } from "../src/assessment/review-model.ts";
import { sameCandidatePath } from "../src/assessment/review-static.ts";

function cite(line: number, role: ReviewCitation["role"], endLine = line): ReviewCitation {
  return { path: "tools.py", line, endLine, role, message: role };
}

describe("cross-origin duplicate check", () => {
  // A flow the model reports from the input to the query and on to the returned rows.
  const ai = { cwe: "CWE-89", evidence: [cite(9, "source"), cite(11, "sink"), cite(12, "flow")] };

  it("matches the sink a candidate marks, not its last citation", () => {
    const rule = { cwe: "CWE-89", evidence: [cite(9, "source", 12), cite(11, "sink")] };
    expect(sameCandidatePath(ai, rule)).toBe(true);
    expect(sameCandidatePath(rule, ai)).toBe(true);
  });

  it("matches a configuration rule that cites only its sink, whatever source the model cites", () => {
    const setting = { cwe: "CWE-502", evidence: [cite(4, "sink")] };
    const model = { cwe: "CWE-502", evidence: [cite(2, "source"), cite(4, "sink")] };
    expect(sameCandidatePath(model, setting)).toBe(true);
  });

  it("accepts a weakness of the same family and rejects another family or a missing CWE", () => {
    const evalRule = { cwe: "CWE-94", evidence: [cite(5, "source"), cite(7, "sink")] };
    const sink = [cite(5, "source"), cite(7, "sink")];
    expect(sameCandidatePath({ cwe: "CWE-95", evidence: sink }, evalRule)).toBe(true);
    expect(sameCandidatePath({ cwe: "CWE-862", evidence: sink }, evalRule)).toBe(false);
    expect(sameCandidatePath({ cwe: null, evidence: sink }, evalRule)).toBe(false);
  });

  it("matches a rule's sink on a flow step the model cites before its own sink", () => {
    // A system prompt rule names the prompt text; the model follows it into the call.
    const rule = {
      cwe: "CWE-1427",
      evidence: [cite(26, "source", 116), cite(70, "source", 77), cite(53, "sink")],
    };
    const model = { cwe: "CWE-1427", evidence: [cite(53, "flow", 67), cite(70, "sink", 86)] };
    expect(sameCandidatePath(rule, model)).toBe(true);
    expect(sameCandidatePath(model, rule)).toBe(true);
    // The rule's sources are still not compared.
    const elsewhere = { cwe: "CWE-1427", evidence: [cite(90, "flow"), cite(100, "sink")] };
    expect(sameCandidatePath(rule, elsewhere)).toBe(false);
  });

  it("rejects the same weakness at another sink", () => {
    const other = { cwe: "CWE-89", evidence: [cite(9, "source"), cite(20, "sink")] };
    expect(sameCandidatePath(ai, other)).toBe(false);
  });

  it("falls back to the last citation of a candidate that marks no sink", () => {
    const unmarked = { cwe: "CWE-89", evidence: [cite(9, "source"), cite(11, "flow")] };
    expect(sameCandidatePath(unmarked, ai)).toBe(true);
    expect(sameCandidatePath({ cwe: "CWE-89", evidence: [] }, ai)).toBe(false);
  });
});
