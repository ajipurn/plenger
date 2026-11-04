import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCorpus } from "../scripts/lib/evaluation.ts";
import { PROOF_ISOLATION_CHECKS, PROOF_SESSION_LIMITS } from "../src/redteam/constants.ts";
import { proofEntries } from "../src/redteam/proof-entry.ts";
import type {
  ProofFamily,
  ProofOutcome,
  ProofRange,
  ProofRunResult,
  ProofWeakness,
} from "../src/redteam/proof-model.ts";
import { runProofTest } from "../src/redteam/proof-run.ts";
import { proofSession } from "../src/redteam/proof-session.ts";
import { scan } from "../src/scan.ts";
import { fixturePath } from "./support/fixtures.ts";

// Built by `pnpm qualify:proof`; see CONTRIBUTING.md. Not part of the offline suite.
const IMAGES: Record<ProofFamily, string | undefined> = {
  python: process.env.PLENGER_TEST_PROOF_PYTHON_IMAGE,
  javascript: process.env.PLENGER_TEST_PROOF_NODE_IMAGE,
};

/** The handwritten test of each case with a proof label. Twins share one when they can. */
const TESTS: Record<string, string> = {
  "py-path-tool-pathlib": "path-tool.py",
  "py-path-tool-confined": "path-tool.py",
  "py-route-send-file-joined": "route-send-file.py",
  "py-route-send-file-directory": "route-send-file.py",
  "ts-route-report-read": "route-report-read.mjs",
  "ts-route-report-read-confined": "route-report-read.mjs",
  "ts-route-doc-unpacked-query": "route-doc-unpacked.mjs",
  "ts-route-doc-unpacked-checked": "route-doc-unpacked.mjs",
  "py-shell-tool": "shell-tool.py",
  "py-shell-tool-allowlist": "shell-tool-allowlist.py",
  "py-route-ping-shell": "route-ping.py",
  "py-route-ping-allowlist": "route-ping.py",
  "py-route-host-helper-shell": "route-host-helper.py",
  "py-route-host-helper-lookup": "route-host-helper.py",
  "ts-route-git-log-exec": "route-git-log.mjs",
  "ts-route-git-log-allowlist": "route-git-log.mjs",
};

const corpus = await loadCorpus(fixturePath("evaluation"));
/** Labeled cases that have a handwritten test; the others are for model sessions. */
const labeled = corpus.filter((item) => item.proof !== undefined && item.id in TESTS);

async function sources(root: string): Promise<{ path: string; content: string }[]> {
  const found: { path: string; content: string }[] = [];
  const walk = async (folder: string) => {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, item.name);
      if (item.isDirectory()) await walk(path);
      else if (item.name !== "case.json")
        found.push({ path: relative(root, path), content: await readFile(path, "utf8") });
    }
  };
  await walk(root);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function familyOf(test: string): ProofFamily {
  return test.endsWith(".py") ? "python" : "javascript";
}

async function prove(options: {
  test: string;
  project: string;
  weakness: ProofWeakness;
  entry: ProofRange[];
  cited: ProofRange[];
}): Promise<ProofRunResult> {
  const family = familyOf(options.test);
  return runProofTest(IMAGES[family] as string, {
    family,
    weakness: options.weakness,
    sources: await sources(fixturePath(options.project)),
    test: await readFile(fixturePath(`proof/${options.test}`), "utf8"),
    entry: options.entry,
    cited: options.cited,
  });
}

it("labels every handwritten test's case, in both families", () => {
  expect(labeled.map((item) => item.id).sort()).toEqual(Object.keys(TESTS).sort());
  const families = new Set(Object.values(TESTS).map(familyOf));
  for (const weakness of ["CWE-22", "CWE-78"])
    expect(
      new Set(
        labeled
          .filter((item) => item.cwe === weakness)
          .map((item) => familyOf(TESTS[item.id] ?? "")),
      ),
    ).toEqual(families);
});

describe("handwritten proof tests on the labeled pairs", () => {
  for (const item of labeled) {
    const test = TESTS[item.id] as string;
    it.skipIf(!IMAGES[familyOf(test)])(
      item.id,
      async () => {
        const result = await prove({
          test,
          project: `evaluation/${item.id}`,
          weakness: item.cwe as ProofWeakness,
          entry: item.proof?.entry ?? [],
          cited: [item.location],
        });
        expect(result.outcome, result.reason).toBe(item.proof?.expected);
        expect(new Set(result.isolationChecks)).toEqual(
          new Set(
            PROOF_ISOLATION_CHECKS[familyOf(test) === "python" ? "proof-python" : "proof-node"],
          ),
        );
      },
      60_000,
    );
  }
});

describe("a scripted session in the real image, with entries from the scan", () => {
  for (const id of [
    "py-shell-tool",
    "py-shell-tool-allowlist",
    "ts-route-git-log-exec",
    "ts-route-git-log-allowlist",
  ]) {
    const item = corpus.find((candidate) => candidate.id === id);
    const test = TESTS[id] as string;
    it.skipIf(!IMAGES[familyOf(test)] || !item)(
      id,
      async () => {
        if (!item) return;
        const family = familyOf(test);
        const source = await readFile(fixturePath(`proof/${test}`), "utf8");
        const entries = proofEntries(await scan(item.root, { facts: true }), [item.location]);
        let turn = 0;
        const result = await proofSession({
          image: IMAGES[family] as string,
          family,
          finding: {
            title: item.summary,
            weakness: item.cwe as ProofWeakness,
            summary: item.summary,
            attackPath: item.summary,
            validation: "source-supported",
            evidence: [{ ...item.location, snippet: "" }],
          },
          entries,
          cited: [item.location],
          sources: await sources(item.root),
          files: [],
          tools: { definitions: [], run: async () => ({}) },
          // A model that runs the handwritten test once, then gives up.
          send: async () => ({
            content: null,
            toolCalls: [
              turn++ === 0
                ? { id: "run", name: "run_test", arguments: { source } }
                : { id: "end", name: "give_up", arguments: { reason: "One test was enough." } },
            ],
          }),
          tokens: { used: () => 0, limit: PROOF_SESSION_LIMITS.tokens },
        });
        expect(entries.via).toBe("inventory");
        expect(result.outcome, result.reason).toBe(item.proof?.expected);
        expect(result.runs).toHaveLength(1);
      },
      120_000,
    );
  }
});

/** Tests that try to fake a proof. None may be Proven. */
const ADVERSARIAL: {
  name: string;
  test: string;
  project: string;
  weakness: ProofWeakness;
  entry: ProofRange;
  cited: ProofRange;
  outcome: ProofOutcome;
  reason?: string;
}[] = [
  {
    name: "a test that reads the canary itself",
    test: "adversarial/own-effect.py",
    project: "evaluation/py-path-tool-confined",
    weakness: "CWE-22",
    entry: { path: "tools.py", line: 11, endLine: 14 },
    cited: { path: "tools.py", line: 9, endLine: 14 },
    outcome: "not-reproduced",
  },
  {
    name: "a callback the test passes to project code",
    test: "adversarial/callback.py",
    project: "proof/projects/callback-python",
    weakness: "CWE-22",
    entry: { path: "jobs.py", line: 2, endLine: 2 },
    cited: { path: "jobs.py", line: 1, endLine: 2 },
    outcome: "not-reproduced",
  },
  {
    name: "a setting the test replaced",
    test: "adversarial/replaced-setting.py",
    project: "evaluation/py-shell-tool-allowlist",
    weakness: "CWE-78",
    entry: { path: "tools.py", line: 14, endLine: 17 },
    cited: { path: "tools.py", line: 12, endLine: 17 },
    outcome: "could-not-run",
    reason: "tools.CHECKS",
  },
  {
    name: "a standard-library check the test replaced",
    test: "adversarial/replaced-stdlib.py",
    project: "evaluation/py-path-tool-confined",
    weakness: "CWE-22",
    entry: { path: "tools.py", line: 11, endLine: 14 },
    cited: { path: "tools.py", line: 9, endLine: 14 },
    outcome: "could-not-run",
    reason: "is_relative_to",
  },
  {
    name: "an environment variable pointed outside the test's folder",
    test: "adversarial/environment.py",
    project: "proof/projects/env-root-python",
    weakness: "CWE-22",
    entry: { path: "files.py", line: 5, endLine: 10 },
    cited: { path: "files.py", line: 4, endLine: 10 },
    outcome: "could-not-run",
    reason: "FILES_ROOT",
  },
  {
    name: "a command canary the test writes or runs itself",
    test: "adversarial/own-canary.py",
    project: "proof/projects/quoted-shell-python",
    weakness: "CWE-78",
    entry: { path: "echo.py", line: 6, endLine: 7 },
    cited: { path: "echo.py", line: 5, endLine: 7 },
    outcome: "not-reproduced",
  },
  {
    name: "a JavaScript intrinsic the test replaced",
    test: "adversarial/replaced-intrinsic.mjs",
    project: "evaluation/ts-route-report-read-confined",
    weakness: "CWE-22",
    entry: { path: "server.ts", line: 8, endLine: 9 },
    cited: { path: "server.ts", line: 7, endLine: 10 },
    outcome: "could-not-run",
    reason: "String.prototype.startsWith",
  },
  {
    name: "a standard-library change undone before the case ends",
    test: "adversarial/transient.py",
    project: "proof/projects/env-root-python",
    weakness: "CWE-22",
    entry: { path: "files.py", line: 5, endLine: 10 },
    cited: { path: "files.py", line: 4, endLine: 10 },
    outcome: "could-not-run",
    reason: "posixpath.realpath",
  },
  {
    name: "a JavaScript intrinsic change undone before the case ends",
    test: "adversarial/transient-intrinsic.mjs",
    project: "evaluation/ts-route-report-read-confined",
    weakness: "CWE-22",
    entry: { path: "server.ts", line: 8, endLine: 9 },
    cited: { path: "server.ts", line: 7, endLine: 10 },
    outcome: "could-not-run",
    reason: "String.prototype.startsWith",
  },
  {
    name: "a JavaScript callback the test passes to project code",
    test: "adversarial/callback.mjs",
    project: "proof/projects/callback-node",
    weakness: "CWE-22",
    entry: { path: "jobs.mjs", line: 2, endLine: 2 },
    cited: { path: "jobs.mjs", line: 1, endLine: 3 },
    outcome: "not-reproduced",
  },
  {
    name: "a working directory moved next to the canary",
    test: "adversarial/working-directory.py",
    project: "proof/projects/env-root-python",
    weakness: "CWE-22",
    entry: { path: "files.py", line: 5, endLine: 10 },
    cited: { path: "files.py", line: 4, endLine: 10 },
    outcome: "not-reproduced",
  },
  {
    name: "a JavaScript working directory moved into a guarded folder",
    test: "adversarial/working-directory.mjs",
    project: "evaluation/ts-read-tool-no-separators",
    weakness: "CWE-22",
    entry: { path: "tools.ts", line: 8, endLine: 11 },
    cited: { path: "tools.ts", line: 8, endLine: 11 },
    outcome: "not-reproduced",
  },
];

describe("tests that try to fake a proof", () => {
  for (const item of ADVERSARIAL)
    it.skipIf(!IMAGES[familyOf(item.test)])(
      item.name,
      async () => {
        const result = await prove({ ...item, entry: [item.entry], cited: [item.cited] });
        expect(result.outcome, result.reason).not.toBe("proven");
        expect(result.outcome, result.reason).toBe(item.outcome);
        if (item.reason) expect(result.reason).toContain(item.reason);
      },
      60_000,
    );
});
