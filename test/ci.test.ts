import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runGitHubAction } from "../scripts/lib/github-action.ts";
import { SourceRootError, sourcePrefix, toMarkdown, toSarif } from "../src/report/format.ts";
import { createReport, failsGate, withoutSuppressed } from "../src/report/model.ts";
import { readBaseline, readSuppressions } from "../src/report/policy.ts";
import { scan } from "../src/scan.ts";
import { baselineOf } from "./support/baseline.ts";
import { temporaryDir } from "./support/tmp.ts";

const unsafe = [
  "from langchain_core.tools import tool",
  "import subprocess",
  "",
  "@tool",
  "def run(command: str):",
  "    return subprocess.run(command, shell=True)",
  "",
].join("\n");

async function withProject(work: (root: string) => Promise<void>) {
  const root = await temporaryDir("plenger-ci-");
  await writeFile(join(root, "tool.py"), unsafe);
  await work(root);
}

describe("report policies used by CI", () => {
  it("matches portable baselines after line edits and relocation, and gates new findings", async () => {
    await withProject(async (root) => {
      const baselineFile = join(root, "baseline.json");
      await writeFile(baselineFile, JSON.stringify(baselineOf((await scan(root)).findings)));
      const baseline = await readBaseline(baselineFile);
      await writeFile(join(root, "tool.py"), `# unrelated line\n${unsafe}`);
      const unchanged = createReport(await scan(root), { baseline });
      expect(unchanged.review).toMatchObject({ new: 0, unchanged: 1 });
      expect(failsGate(unchanged, "low")).toBe(false);
      const copy = await temporaryDir("plenger-relocated-");
      await writeFile(join(copy, "tool.py"), unsafe);
      expect(failsGate(createReport(await scan(copy), { baseline }), "low")).toBe(false);
      await writeFile(join(root, "second.py"), unsafe.replace("def run(", "def other("));
      const changed = createReport(await scan(root), { baseline });
      expect(changed.review).toMatchObject({ new: 1, unchanged: 1 });
      expect(failsGate(changed, "critical")).toBe(true);
    });
  });

  it("retains suppression reasons, excludes suppressed findings, and gates the remainder", async () => {
    await withProject(async (root) => {
      const first = (await scan(root)).findings[0];
      const suppression = join(root, "suppressions.json");
      await writeFile(
        suppression,
        JSON.stringify({
          schemaVersion: 1,
          suppressions: [{ fingerprint: first?.fingerprint, reason: "Reviewed proxy validation" }],
        }),
      );
      const suppressions = await readSuppressions(suppression);
      const report = createReport(await scan(root), { suppressions });
      expect(report.review).toMatchObject({ active: 0, suppressed: 1 });
      expect(report.findings[0]?.suppression?.reason).toBe("Reviewed proxy validation");
      expect(failsGate(report, "low")).toBe(false);
      expect(withoutSuppressed(report).findings).toEqual([]);
      await writeFile(join(root, "second.py"), unsafe);
      expect(failsGate(createReport(await scan(root), { suppressions }), "high")).toBe(true);
    });
  });

  it("keeps in-source suppressions visible in SARIF and Markdown", async () => {
    await withProject(async (root) => {
      await writeFile(
        join(root, "tool.py"),
        unsafe.replace(
          "    return subprocess.run(command, shell=True)",
          "    # plenger-ignore PLG101 runs only in the build sandbox\n    return subprocess.run(command, shell=True)",
        ),
      );
      await writeFile(
        join(root, "other.py"),
        unsafe.replace("shell=True)", "shell=True)  # plenger-ignore PLG104 wrong rule"),
      );
      const result = await scan(root);
      const reviewed = createReport(result);
      expect(reviewed.review).toMatchObject({ active: 1, suppressed: 1 });
      const sarif = toSarif(reviewed) as { runs: { results: { suppressions?: unknown[] }[] }[] };
      expect(sarif.runs[0]?.results.flatMap((item) => item.suppressions ?? [])).toEqual([
        { kind: "inSource", status: "accepted", justification: "runs only in the build sandbox" },
      ]);
      expect(toMarkdown(reviewed)).toContain("Suppressed by a comment in the code");
    });
  });

  it("keeps SARIF paths relative to the repository and validates policy files", async () => {
    await withProject(async (root) => {
      await mkdir(join(root, "src"));
      await rename(join(root, "tool.py"), join(root, "src/tool.py"));
      const report = createReport(await scan(join(root, "src")));
      sourcePrefix(report, root);
      const sarif = toSarif(report, { sourceRoot: root }) as {
        runs: {
          results: { locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }[];
        }[];
      };
      expect(sarif.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe(
        "src/tool.py",
      );
      expect(() => sourcePrefix(report, join(root, "outside"))).toThrow(SourceRootError);
      const bad = join(root, "bad.json");
      await writeFile(bad, "{}");
      await expect(readBaseline(bad)).rejects.toThrow();
      await expect(readSuppressions(bad)).rejects.toThrow();
    });
  });
});

describe("GitHub Action", () => {
  it("writes SARIF, outputs and the job summary even when the scan fails its gate", async () => {
    await withProject(async (root) => {
      const outputs = join(root, "outputs.txt");
      const summary = join(root, "summary.md");
      let stderr = "";
      const code = await runGitHubAction(
        {
          GITHUB_WORKSPACE: root,
          GITHUB_OUTPUT: outputs,
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_REPOSITORY: "example/agent-project",
          GITHUB_SHA: "abcdef",
          PLENGER_SARIF_FILE: "reports/scan.sarif",
        },
        {
          stdout: () => {},
          stderr: (text) => {
            stderr += text;
          },
          color: false,
        },
      );
      expect(code).toBe(3);
      expect(stderr).toContain("findings meet fail-on high");
      expect(await readFile(outputs, "utf8")).toBe("sarif-file=reports/scan.sarif\nexit-code=3\n");
      expect(await readFile(summary, "utf8")).toContain("PLG101");
      expect(await readFile(summary, "utf8")).toContain(
        "https://github.com/example/agent-project/blob/abcdef/tool.py#L",
      );
      expect(
        JSON.parse(await readFile(join(root, "reports/scan.sarif"), "utf8")).runs[0].results,
      ).toHaveLength(1);
    });
  });

  it("passes baseline and suppression inputs and supports disabling the gate", async () => {
    await withProject(async (root) => {
      const baseline = join(root, "baseline.json");
      await writeFile(baseline, JSON.stringify(baselineOf((await scan(root)).findings)));
      const suppression = join(root, "suppression.json");
      await writeFile(
        suppression,
        JSON.stringify({
          schemaVersion: 1,
          suppressions: [{ rule: "PLG101", reason: "Reviewed" }],
        }),
      );
      const env = {
        GITHUB_WORKSPACE: root,
        PLENGER_BASELINE: "baseline.json",
        PLENGER_SUPPRESSIONS: "suppression.json",
      };
      const io = { stdout: () => {}, stderr: () => {}, color: false };
      const sarif = async () =>
        JSON.parse(await readFile(join(root, "plenger.sarif"), "utf8")).runs[0];
      // GitHub ignores SARIF suppressions, so suppressed findings stay out of the upload by default.
      expect(await runGitHubAction(env, io)).toBe(0);
      expect((await sarif()).results).toEqual([]);
      expect((await sarif()).properties.review).toMatchObject({ suppressed: 1 });
      expect(await runGitHubAction({ ...env, PLENGER_INCLUDE_SUPPRESSED: "true" }, io)).toBe(0);
      expect((await sarif()).results[0]).toMatchObject({
        baselineState: "unchanged",
        suppressions: [{ status: "accepted" }],
      });
      expect(await runGitHubAction({ GITHUB_WORKSPACE: root, PLENGER_FAIL_ON: "none" }, io)).toBe(
        0,
      );
    });
  });

  it("writes SARIF paths and summary links from the repository root when scanning a subdirectory", async () => {
    await withProject(async (root) => {
      await mkdir(join(root, "src", "agents"), { recursive: true });
      await rename(join(root, "tool.py"), join(root, "src", "agents", "tool.py"));
      const summary = join(root, "summary.md");
      const io = { stdout: () => {}, stderr: () => {}, color: false };
      const env = {
        GITHUB_WORKSPACE: root,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_REPOSITORY: "example/agent-project",
        GITHUB_SHA: "abcdef",
        PLENGER_PATH: "src",
        PLENGER_FAIL_ON: "none",
      };
      expect(await runGitHubAction(env, io)).toBe(0);
      const run = JSON.parse(await readFile(join(root, "plenger.sarif"), "utf8")).runs[0];
      expect(run.results[0].locations[0].physicalLocation.artifactLocation.uri).toBe(
        "src/agents/tool.py",
      );
      expect(await readFile(summary, "utf8")).toContain(
        "https://github.com/example/agent-project/blob/abcdef/src/agents/tool.py#L",
      );
      // A repository checked out into a subdirectory of the workspace.
      expect(await runGitHubAction({ ...env, PLENGER_SOURCE_ROOT: "src" }, io)).toBe(0);
      expect(
        JSON.parse(await readFile(join(root, "plenger.sarif"), "utf8")).runs[0].results[0]
          .locations[0].physicalLocation.artifactLocation.uri,
      ).toBe("agents/tool.py");
      expect(await runGitHubAction({ ...env, PLENGER_SOURCE_ROOT: "src/agents" }, io)).toBe(2);
      expect(await runGitHubAction({ ...env, PLENGER_SOURCE_ROOT: "missing" }, io)).toBe(2);
    });
  });

  it("rejects invalid inputs and preserves operational failures", async () => {
    const io = { stdout: () => {}, stderr: () => {}, color: false };
    expect(await runGitHubAction({}, io)).toBe(2);
    await withProject(async (root) => {
      expect(
        await runGitHubAction(
          { GITHUB_WORKSPACE: root, PLENGER_SARIF_FILE: "../outside.sarif" },
          io,
        ),
      ).toBe(2);
      expect(
        await runGitHubAction({ GITHUB_WORKSPACE: root, PLENGER_SARIF_FILE: "out\nextra=1" }, io),
      ).toBe(2);
      expect(await runGitHubAction({ GITHUB_WORKSPACE: root, PLENGER_PATH: "missing" }, io)).toBe(
        1,
      );
      expect(
        await runGitHubAction({ GITHUB_WORKSPACE: root, PLENGER_FAIL_ON: "urgent" }, io),
      ).toBe(2);
      expect(
        await runGitHubAction({ GITHUB_WORKSPACE: root, PLENGER_GITIGNORE: "typo" }, io),
      ).toBe(2);
      expect(
        await runGitHubAction({ GITHUB_WORKSPACE: root, PLENGER_INCLUDE_SUPPRESSED: "yes" }, io),
      ).toBe(2);
    });
  });

  it("rejects an output directory symlink that escapes the workspace", async () => {
    await withProject(async (root) => {
      const outside = await temporaryDir("plenger-outside-");
      try {
        await symlink(
          outside,
          join(root, "reports"),
          process.platform === "win32" ? "junction" : "dir",
        );
        expect(
          await runGitHubAction(
            { GITHUB_WORKSPACE: root, PLENGER_SARIF_FILE: "reports/out.sarif" },
            { stdout: () => {}, stderr: () => {}, color: false },
          ),
        ).toBe(2);
        await symlink(join(outside, "missing.sarif"), join(root, "dangling.sarif"), "file");
        expect(
          await runGitHubAction(
            { GITHUB_WORKSPACE: root, PLENGER_SARIF_FILE: "dangling.sarif" },
            { stdout: () => {}, stderr: () => {}, color: false },
          ),
        ).toBe(2);
      } finally {
        // temporaryDir removes both roots after this test.
      }
    });
  });

  it("declares a composite action with quoted commands and env-bound inputs, and a local CI smoke test", async () => {
    const action = parse(await readFile(new URL("../action.yml", import.meta.url), "utf8"));
    expect(action.runs.using).toBe("composite");
    const step = action.runs.steps.find((item: { id?: string }) => item.id === "scan");
    expect(step.run).toBe('node "$GITHUB_ACTION_PATH/scripts/github-action.ts"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
    expect(step.env.PLENGER_PATH).toBe("${{ inputs.path }}");
    const workflow = parse(
      await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
    );
    expect(workflow.jobs.action.steps.some((item: { uses?: string }) => item.uses === "./")).toBe(
      true,
    );
    expect(workflow.permissions).toEqual({ contents: "read" });
    // Third-party actions run with the job's token; pin them to commits, not movable tags.
    const steps = [
      ...action.runs.steps,
      ...Object.values(workflow.jobs as Record<string, { steps: { uses?: string }[] }>).flatMap(
        (job) => job.steps,
      ),
    ];
    const remote = steps
      .map((item: { uses?: string }) => item.uses)
      .filter((uses): uses is string => uses !== undefined && !uses.startsWith("./"));
    expect(remote.length).toBeGreaterThan(0);
    for (const uses of remote) expect(uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
    expect(step.env.PLENGER_SOURCE_ROOT).toBe("${{ inputs.source-root }}");
    expect(action.inputs["include-suppressed"].default).toBe("false");
  });
});
