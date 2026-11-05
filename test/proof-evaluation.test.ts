import { describe, expect, it } from "vitest";
import { loadCorpus } from "../scripts/lib/evaluation.ts";
import {
  formatProofEvaluation,
  type ProofCaseOutcome,
  proveCase,
  scoreProof,
} from "../scripts/lib/proof-evaluation.ts";
import type { ProofSessionOptions, ProofSessionResult } from "../src/redteam/proof-session.ts";
import { fixturePath } from "./support/fixtures.ts";

const corpus = await loadCorpus(fixturePath("evaluation"));
const access = { provider: "openai" as const, model: "gpt-test", apiKey: "sk-test-not-used" };
const images = { python: `sha256:${"1".repeat(64)}`, javascript: `sha256:${"2".repeat(64)}` };

function result(outcome: ProofSessionResult["outcome"]): ProofSessionResult {
  return {
    outcome,
    reason: `${outcome} reason`,
    deciding: null,
    runs: [],
    record: { stop: "gave-up", modelCalls: 3, toolCalls: {}, durationMs: 1 },
  };
}

describe("proof evaluation", () => {
  it("gives both twins the same neutral finding, the derived entry and read tools", async () => {
    const seen: ProofSessionOptions[] = [];
    const session = async (options: ProofSessionOptions) => {
      seen.push(options);
      return result("proven");
    };
    for (const id of ["py-route-ping-shell", "py-route-ping-allowlist"]) {
      const item = corpus.find((candidate) => candidate.id === id);
      if (!item) throw new Error(id);
      const outcome = await proveCase(item, { access, images, session });
      expect(outcome).toMatchObject({
        id,
        outcome: "proven",
        modelCalls: 3,
        entryMatchesLabel: true,
      });
    }
    const [vulnerable, safe] = seen;
    expect(vulnerable?.finding).toEqual(safe?.finding);
    expect(vulnerable?.finding.summary).not.toContain("allowlist");
    expect(safe?.entries).toEqual({
      ranges: [{ path: "app/main.py", line: 11, endLine: 14 }],
      via: "inventory",
    });
    expect(safe?.image).toBe(images.python);
    expect(safe?.files.map((file) => file.path)).toEqual(["app/main.py", "app/diagnostics.py"]);
    expect(safe?.files[0]?.text).toContain("11: def ping_host");
    expect(safe?.sources.map((source) => source.path)).not.toContain("case.json");
    const names = safe?.tools.definitions.map(
      (item) => (item as { function: { name: string } }).function.name,
    );
    expect(names).toEqual(["list_files", "read_file", "search", "outline"]);
    expect(await safe?.tools.run("read_file", { path: "app/main.py" })).toMatchObject({
      text: expect.stringContaining("HOSTS"),
    });
  });

  it("records a session that failed and scores it as nothing", async () => {
    const item = corpus.find((candidate) => candidate.id === "py-shell-tool");
    if (!item) throw new Error("py-shell-tool");
    const outcome = await proveCase(item, {
      access,
      images,
      session: async () => {
        throw new Error("The provider returned HTTP 500.");
      },
    });
    expect(outcome).toMatchObject({ outcome: "failed", reason: "The provider returned HTTP 500." });
    expect(scoreProof([outcome])).toMatchObject({ failed: 1, vulnerable: 0, proven: 0 });
  });

  it("counts a Proven safe twin as a false proof and keeps unprovable cases out of yield", () => {
    const outcome = (
      id: string,
      kind: "vulnerable" | "safe",
      value: ProofCaseOutcome["outcome"],
      unprovable = false,
    ) =>
      ({
        id,
        kind,
        expected: kind === "vulnerable" ? "proven" : "not-reproduced",
        outcome: value,
        reason: "",
        stop: "proven",
        modelCalls: 2,
        testRuns: 1,
        tokens: 1000,
        durationMs: 1,
        entryMatchesLabel: true,
        unprovable,
      }) satisfies ProofCaseOutcome;
    const run = [
      outcome("a", "vulnerable", "proven"),
      outcome("b", "vulnerable", "could-not-run"),
      outcome("c", "safe", "not-reproduced"),
      outcome("d", "safe", "proven"),
      outcome("e", "vulnerable", "not-reproduced", true),
    ];
    expect(scoreProof(run)).toMatchObject({
      vulnerable: 2,
      proven: 1,
      unprovableProven: 0,
      safe: 2,
      falseProofs: 1,
      tokens: 5000,
      stops: { proven: 5 },
    });
    const report = formatProofEvaluation(
      { provider: { name: "Test", model: "m" }, runs: [run] },
      "2026-11-04",
    );
    expect(report).toContain("| 1 | 1 of 2 | 1 of 2 |");
    expect(report).toContain("| `d` | safe | proven |");
    expect(report).toContain("| `e` | vulnerable, unprovable | not-reproduced |");
  });
});
