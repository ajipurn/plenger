import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runGitHubAction } from "../src/cli/commands/github-action.ts";
import { main } from "../src/cli/index.ts";

const unsafe = `from langchain_core.tools import tool
import subprocess

@tool
def run(command: str):
    return subprocess.run(command, shell=True)
`;
async function run(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    color: true,
  });
  return { code, stdout, stderr };
}
async function withProject(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "plenger-ci-"));
  try {
    await writeFile(join(root, "tool.py"), unsafe);
    await work(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("CLI reports and CI", () => {
  it("writes a complete SARIF file before failing the severity gate", async () => {
    await withProject(async (root) => {
      const output = join(root, "reports", "scan.sarif");
      const result = await run(
        "scan",
        root,
        "--format",
        "sarif",
        "--output",
        output,
        "--fail-on",
        "high",
      );
      expect(result).toMatchObject({
        code: 3,
        stdout: "",
        stderr: expect.stringContaining("--fail-on high"),
      });
      const document = JSON.parse(await readFile(output, "utf8"));
      expect(document.version).toBe("2.1.0");
      expect(document.runs[0].results[0].ruleId).toBe("PLG101");
    });
  });

  it("compares a portable baseline after unrelated line edits and gates newly introduced risks", async () => {
    await withProject(async (root) => {
      const baseline = join(root, "baseline.json");
      expect((await run("scan", root, "--write-baseline", baseline)).code).toBe(0);
      await writeFile(join(root, "tool.py"), `# unrelated line\n${unsafe}`);
      const compared = await run(
        "scan",
        root,
        "--baseline",
        baseline,
        "--format",
        "json",
        "--fail-on",
        "low",
      );
      expect(compared.code).toBe(0);
      expect(JSON.parse(compared.stdout).review).toMatchObject({ new: 0, unchanged: 1 });
      const copy = await mkdtemp(join(tmpdir(), "plenger-relocated-"));
      try {
        await writeFile(join(copy, "tool.py"), unsafe);
        expect((await run("scan", copy, "--baseline", baseline, "--fail-on", "low")).code).toBe(0);
      } finally {
        await rm(copy, { recursive: true, force: true });
      }
      await writeFile(join(root, "second.py"), unsafe.replace("def run(", "def other("));
      const changed = await run(
        "scan",
        root,
        "--baseline",
        baseline,
        "--json",
        "--fail-on",
        "critical",
      );
      expect(changed.code).toBe(3);
      expect(JSON.parse(changed.stdout).review).toMatchObject({ new: 1, unchanged: 1 });
    });
  });

  it("suppresses an exact finding, retains its reason, and applies the gate to the remainder", async () => {
    await withProject(async (root) => {
      const first = JSON.parse((await run("scan", root, "--json")).stdout).findings[0];
      const suppression = join(root, "suppressions.json");
      await writeFile(
        suppression,
        JSON.stringify({
          schemaVersion: 1,
          suppressions: [
            { fingerprint: first.fingerprint, reason: "Shell input validated at the proxy" },
          ],
        }),
      );
      const result = await run(
        "scan",
        root,
        "--suppressions",
        suppression,
        "--json",
        "--fail-on",
        "low",
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        review: { active: 0, suppressed: 1 },
        findings: [{ suppression: { reason: "Shell input validated at the proxy" } }],
      });
      await writeFile(join(root, "second.py"), unsafe);
      expect(
        (await run("scan", root, "--suppressions", suppression, "--fail-on", "high")).code,
      ).toBe(3);
    });
  });

  it("honours plenger-ignore comments for the named rule, unless told not to", async () => {
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
        `${unsafe}# trailing\n`.replace(
          "shell=True)",
          "shell=True)  # plenger-ignore PLG104 wrong rule",
        ),
      );
      const result = await run("scan", root, "--json", "--fail-on", "critical");
      const report = JSON.parse(result.stdout);
      expect(result.code).toBe(3);
      expect(report.review).toMatchObject({ active: 1, suppressed: 1 });
      expect(
        report.findings.find(
          (finding: { location: { path: string } }) => finding.location.path === "tool.py",
        ),
      ).toMatchObject({
        suppression: { reason: "runs only in the build sandbox", inSource: true },
      });
      const sarif = JSON.parse((await run("scan", root, "--format", "sarif")).stdout);
      expect(
        sarif.runs[0].results.flatMap(
          (item: { suppressions?: unknown[] }) => item.suppressions ?? [],
        ),
      ).toEqual([
        { kind: "inSource", status: "accepted", justification: "runs only in the build sandbox" },
      ]);
      const audit = JSON.parse(
        (await run("scan", root, "--json", "--no-inline-suppressions")).stdout,
      );
      expect(audit.review).toMatchObject({ active: 2, suppressed: 0 });
    });
  });

  it("writes Markdown and plain terminal output without ANSI and supports --json as an alias", async () => {
    await withProject(async (root) => {
      const output = join(root, "report.md");
      expect((await run("scan", root, "--format", "markdown", "--output", output)).stdout).toBe("");
      expect(await readFile(output, "utf8")).toContain("Remediation:");
      expect((await run("scan", root, "--json", "--format", "json")).code).toBe(0);
      await run("scan", root, "--output", output);
      expect(await readFile(output, "utf8")).not.toContain("\u001b[");
    });
  });

  it("makes SARIF paths relative to --source-root and can omit suppressed findings", async () => {
    await withProject(async (root) => {
      await mkdir(join(root, "src"));
      await rename(join(root, "tool.py"), join(root, "src", "tool.py"));
      const scanned = join(root, "src");
      const sarif = await run("scan", scanned, "--format", "sarif", "--source-root", root);
      expect(sarif.code).toBe(0);
      expect(
        JSON.parse(sarif.stdout).runs[0].results[0].locations[0].physicalLocation.artifactLocation
          .uri,
      ).toBe("src/tool.py");
      expect((await run("scan", root, "--format", "sarif", "--source-root", scanned)).code).toBe(2);
      expect((await run("scan", scanned, "--source-root", join(root, "missing"))).code).toBe(2);
      expect((await run("rules", "--source-root", root)).code).toBe(2);

      const suppressions = join(root, "suppressions.json");
      await writeFile(
        suppressions,
        JSON.stringify({
          schemaVersion: 1,
          suppressions: [{ rule: "PLG101", reason: "Reviewed" }],
        }),
      );
      const omitted = await run(
        "scan",
        scanned,
        "--json",
        "--suppressions",
        suppressions,
        "--omit-suppressed",
      );
      const report = JSON.parse(omitted.stdout);
      expect(report.findings).toEqual([]);
      expect(report.review).toMatchObject({ active: 0, suppressed: 1 });
    });
  });

  it("distinguishes usage/policy errors from scan and output failures", async () => {
    for (const args of [
      ["scan", "--format", "html"],
      ["scan", "--fail-on", "urgent"],
      ["scan", "--output", ""],
      ["scan", "--baseline", ""],
      ["scan", "--json", "--format", "sarif"],
      ["facts", "--format", "markdown"],
      ["rules", "--baseline", "baseline.json"],
      ["rules", "--format", "sarif"],
      ["scan", "--write-baseline", "same.json", "--output", "same.json"],
    ])
      expect((await run(...args)).code).toBe(2);
    await withProject(async (root) => {
      const bad = join(root, "bad.json");
      await writeFile(bad, "{}");
      expect((await run("scan", root, "--baseline", bad)).code).toBe(2);
      expect((await run("scan", root, "--suppressions", join(root, "absent.json"))).code).toBe(1);
      expect((await run("scan", root, "--output", root)).code).toBe(1);
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
      expect(stderr).toContain("--fail-on high");
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
      await run("scan", root, "--write-baseline", baseline);
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
      const outside = await mkdtemp(join(tmpdir(), "plenger-outside-"));
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
        await rm(outside, { recursive: true, force: true });
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
