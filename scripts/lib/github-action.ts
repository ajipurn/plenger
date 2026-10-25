import { appendFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { type Io, writeOutput } from "../../src/cli/io.ts";
import { SourceRootError, sourcePrefix, toMarkdown, toSarif } from "../../src/report/format.ts";
import { createReport, type FailOn, failsGate, withoutSuppressed } from "../../src/report/model.ts";
import { PolicyError, readBaseline, readSuppressions } from "../../src/report/policy.ts";
import { SEVERITIES } from "../../src/rules/model.ts";
import { scan } from "../../src/scan.ts";
import { json } from "../../src/shared/json.ts";
import {
  aiFailsGate,
  aiReviewInputs,
  aiSarifRun,
  aiSummary,
  runAiReview,
} from "./github-action-review.ts";

/** Scan once, then emit SARIF and a job summary even when the finding gate fails. */
export async function runGitHubAction(
  env: Record<string, string | undefined> = process.env,
  io: Io = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    color: false,
  },
): Promise<number> {
  const workspace = env.GITHUB_WORKSPACE;
  if (!workspace) {
    io.stderr("plenger: GITHUB_WORKSPACE is required\n");
    return 2;
  }
  const output = resolve(workspace, env.PLENGER_SARIF_FILE || "plenger.sarif");
  const outputName = relative(workspace, output).replaceAll("\\", "/");
  if (
    isAbsolute(outputName) ||
    outputName.startsWith("../") ||
    outputName === ".." ||
    /[\r\n]/.test(outputName)
  ) {
    io.stderr("plenger: SARIF output must be inside GITHUB_WORKSPACE and have no newlines\n");
    return 2;
  }
  for (const [input, value] of [
    ["gitignore", env.PLENGER_GITIGNORE],
    ["include-suppressed", env.PLENGER_INCLUDE_SUPPRESSED],
  ] as const) {
    if (value !== undefined && value !== "" && !["true", "false"].includes(value)) {
      io.stderr(`plenger: ${input} input must be true or false\n`);
      return 2;
    }
  }
  // Code scanning resolves SARIF paths from the repository root, which is the
  // workspace unless the repository was checked out into a subdirectory.
  let sourceRoot: string;
  try {
    sourceRoot = await realpath(resolve(workspace, env.PLENGER_SOURCE_ROOT || "."));
  } catch {
    io.stderr("plenger: source-root must be an existing directory in GITHUB_WORKSPACE\n");
    return 2;
  }
  const threshold = env.PLENGER_FAIL_ON || "high";
  if (threshold !== "none" && !(SEVERITIES as readonly string[]).includes(threshold)) {
    io.stderr("plenger: fail-on must be critical, high, medium, low or none\n");
    return 2;
  }
  const ai = aiReviewInputs(env);
  if (typeof ai === "string") {
    io.stderr(`plenger: ${ai}\n`);
    return 2;
  }
  try {
    if (!(await outputStaysInWorkspace(output, workspace))) {
      io.stderr("plenger: SARIF output resolves outside GITHUB_WORKSPACE through a symlink\n");
      return 2;
    }
    const baseline = env.PLENGER_BASELINE
      ? await readBaseline(resolve(workspace, env.PLENGER_BASELINE))
      : undefined;
    const suppressions = env.PLENGER_SUPPRESSIONS
      ? await readSuppressions(resolve(workspace, env.PLENGER_SUPPRESSIONS))
      : undefined;
    const scanned = resolve(workspace, env.PLENGER_PATH || ".");
    const result = await scan(scanned, {
      gitignore: env.PLENGER_GITIGNORE !== "false",
      // The AI review also reads text files without a parser, as the dashboard does.
      ...(ai ? { texts: true } : {}),
    });
    const report = createReport(result, {
      ...(baseline ? { baseline } : {}),
      ...(suppressions ? { suppressions } : {}),
    });
    let prefix = "";
    try {
      prefix = sourcePrefix(report, sourceRoot);
    } catch (error) {
      if (!(error instanceof SourceRootError)) throw error;
      io.stderr("plenger: path must be inside source-root\n");
      if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, "exit-code=2\n", "utf8");
      return 2;
    }
    const review = ai ? await runAiReview(ai, result) : null;
    const gate =
      failsGate(report, threshold as FailOn) || (review !== null && aiFailsGate(review, threshold));
    const aiFailed = review !== null && review.status !== "completed";
    const code = gate ? 3 : aiFailed ? 1 : 0;
    // GitHub does not honour SARIF suppressions, so suppressed findings would show
    // as open alerts; they stay in the job summary with their reasons.
    const uploaded = env.PLENGER_INCLUDE_SUPPRESSED === "true" ? report : withoutSuppressed(report);
    const sarif = toSarif(uploaded, { sourceRoot });
    if (review) (sarif.runs as unknown[]).push(aiSarifRun(review, prefix));
    await writeOutput(output, json(sarif));
    if (env.GITHUB_STEP_SUMMARY) {
      const sourceBaseUrl =
        env.GITHUB_REPOSITORY && env.GITHUB_SHA
          ? `${env.GITHUB_SERVER_URL || "https://github.com"}/${env.GITHUB_REPOSITORY}/blob/${env.GITHUB_SHA}/`
          : undefined;
      const summary = toMarkdown(report, {
        sourceRoot,
        ...(sourceBaseUrl ? { sourceBaseUrl } : {}),
      });
      // GitHub accepts at most 1 MiB per step summary. Full details stay in SARIF.
      const boundedSummary =
        Buffer.byteLength(summary) <= 1_000_000
          ? summary
          : `# Plenger static analysis\n\n${report.review.active} active ${report.review.active === 1 ? "finding" : "findings"} · ${report.review.suppressed} suppressed · ${report.review.unchanged} in baseline\n\nThe full summary exceeds GitHub's size limit. Review the complete SARIF report.\n`;
      await appendFile(env.GITHUB_STEP_SUMMARY, boundedSummary, "utf8");
      if (review)
        await appendFile(env.GITHUB_STEP_SUMMARY, aiSummary(review).slice(0, 200_000), "utf8");
    }
    if (env.GITHUB_OUTPUT)
      await appendFile(env.GITHUB_OUTPUT, `sarif-file=${outputName}\nexit-code=${code}\n`, "utf8");
    io.stdout(
      `plenger: ${report.review.active} active ${report.review.active === 1 ? "finding" : "findings"}; SARIF written to ${outputName}\n`,
    );
    if (review)
      io.stdout(
        `plenger: AI review ${review.status}; ${review.findings.filter((finding) => finding.validation !== "dismissed").length} kept findings\n`,
      );
    if (aiFailed)
      io.stderr(`plenger: AI review ${review?.status}: ${review?.reason ?? "no reason"}\n`);
    if (code === 3) io.stderr(`plenger: new unsuppressed findings meet fail-on ${threshold}\n`);
    return code;
  } catch (error) {
    io.stderr(`plenger: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof PolicyError ? 2 : 1;
  }
}

/** Check existing ancestors before creating directories or following an output-file symlink. */
async function outputStaysInWorkspace(output: string, workspace: string): Promise<boolean> {
  const root = await realpath(workspace);
  let ancestor = output;
  while (true) {
    try {
      const path = relative(root, await realpath(ancestor));
      return (
        !isAbsolute(path) &&
        path !== ".." &&
        !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      try {
        ancestor = resolve(dirname(ancestor), await readlink(ancestor));
        continue;
      } catch (linkError) {
        if (
          !(
            linkError instanceof Error &&
            "code" in linkError &&
            ["ENOENT", "EINVAL"].includes(String(linkError.code))
          )
        )
          throw linkError;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}
