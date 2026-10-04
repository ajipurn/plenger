import { appendFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { SourceRootError, sourcePrefix, toMarkdown, toSarif } from "../../report/format.ts";
import { type Report, withoutSuppressed } from "../../report/model.ts";
import { json } from "../../shared/json.ts";
import { main } from "../index.ts";
import { type Io, writeOutput } from "../io.ts";

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
  const args = [
    "scan",
    resolve(workspace, env.PLENGER_PATH || "."),
    "--format",
    "json",
    "--fail-on",
    env.PLENGER_FAIL_ON || "high",
  ];
  if (env.PLENGER_BASELINE) args.push("--baseline", resolve(workspace, env.PLENGER_BASELINE));
  if (env.PLENGER_SUPPRESSIONS)
    args.push("--suppressions", resolve(workspace, env.PLENGER_SUPPRESSIONS));
  if (env.PLENGER_GITIGNORE === "false") args.push("--no-gitignore");
  let outputText = "";
  try {
    if (!(await outputStaysInWorkspace(output, workspace))) {
      io.stderr("plenger: SARIF output resolves outside GITHUB_WORKSPACE through a symlink\n");
      return 2;
    }
    const code = await main(args, {
      ...io,
      stdout: (text) => {
        outputText += text;
      },
      color: false,
    });
    if (outputText) {
      const report = JSON.parse(outputText) as Report;
      try {
        sourcePrefix(report, sourceRoot);
      } catch (error) {
        if (!(error instanceof SourceRootError)) throw error;
        io.stderr("plenger: path must be inside source-root\n");
        if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, "exit-code=2\n", "utf8");
        return 2;
      }
      // GitHub does not honour SARIF suppressions, so suppressed findings would show
      // as open alerts; they stay in the job summary with their reasons.
      const uploaded =
        env.PLENGER_INCLUDE_SUPPRESSED === "true" ? report : withoutSuppressed(report);
      await writeOutput(output, json(toSarif(uploaded, { sourceRoot })));
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
            : `# plenger scan\n\n${report.review.active} active ${report.review.active === 1 ? "finding" : "findings"} · ${report.review.suppressed} suppressed · ${report.review.unchanged} in baseline\n\nThe full summary exceeds GitHub's size limit. Review the complete SARIF report.\n`;
        await appendFile(env.GITHUB_STEP_SUMMARY, boundedSummary, "utf8");
      }
      if (env.GITHUB_OUTPUT)
        await appendFile(
          env.GITHUB_OUTPUT,
          `sarif-file=${outputName}\nexit-code=${code}\n`,
          "utf8",
        );
      io.stdout(
        `plenger: ${report.review.active} active ${report.review.active === 1 ? "finding" : "findings"}; SARIF written to ${outputName}\n`,
      );
    } else if (env.GITHUB_OUTPUT)
      await appendFile(env.GITHUB_OUTPUT, `exit-code=${code}\n`, "utf8");
    return code;
  } catch (error) {
    io.stderr(`plenger: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
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
