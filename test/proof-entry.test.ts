import { describe, expect, it } from "vitest";
import { loadCorpus } from "../scripts/lib/evaluation.ts";
import { proofEntries } from "../src/redteam/proof-entry.ts";
import { scan } from "../src/scan.ts";
import { fixturePath } from "./support/fixtures.ts";

const corpus = await loadCorpus(fixturePath("evaluation"));
const labeled = corpus.filter((item) => item.proof !== undefined);

async function entriesOf(id: string, cited?: { path: string; line: number; endLine: number }) {
  const item = corpus.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`No case ${id}`);
  return proofEntries(await scan(item.root, { facts: true }), [cited ?? item.location]);
}

describe("proof entries", () => {
  it.each(labeled.map((item) => [item.id, item] as const))(
    "%s: the derived entry holds the labeled one",
    async (_, item) => {
      const { ranges } = await entriesOf(item.id);
      for (const label of item.proof?.entry ?? [])
        expect(
          ranges.some(
            (range) =>
              range.path === label.path &&
              range.line <= label.line &&
              range.endLine >= label.endLine,
          ),
          `${label.path}:${label.line}-${label.endLine} in ${JSON.stringify(ranges)}`,
        ).toBe(true);
    },
  );

  it("takes the route that guards a helper, never the helper", async () => {
    // The shell call in diagnostics.py is the same in both twins; the route's allowlist decides.
    expect(await entriesOf("py-route-ping-allowlist")).toEqual({
      ranges: [{ path: "app/main.py", line: 11, endLine: 14 }],
      via: "inventory",
    });
  });

  it("uses the public function only in a project without routes or tools", async () => {
    expect(await entriesOf("py-remote-job-shell")).toEqual({
      ranges: [{ path: "worker.py", line: 6, endLine: 9 }],
      via: "public-function",
    });
    // A project with a route gives no entry for code the route does not reach.
    expect(
      await entriesOf("py-route-ping-allowlist", { path: "app/settings.py", line: 9, endLine: 10 }),
    ).toEqual({ ranges: [], via: null });
  });
});
