import { appendFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { type Io, main, writeOutput } from "../cli.ts";
import { artifactUri, json, toMarkdown, toSarif } from "./format.ts";
import type { Report } from "./model.ts";

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
  if (env.PLENGER_GITIGNORE !== undefined && !["true", "false"].includes(env.PLENGER_GITIGNORE)) {
    io.stderr("plenger: gitignore input must be true or false\n");
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
      await writeOutput(output, json(toSarif(report)));
      if (env.GITHUB_STEP_SUMMARY) {
        const rootPath = relative(await realpath(workspace), report.root).replaceAll("\\", "/");
        const inRepository =
          !isAbsolute(rootPath) && rootPath !== ".." && !rootPath.startsWith("../");
        const sourceBaseUrl =
          inRepository && env.GITHUB_REPOSITORY && env.GITHUB_SHA
            ? `${env.GITHUB_SERVER_URL || "https://github.com"}/${env.GITHUB_REPOSITORY}/blob/${env.GITHUB_SHA}/${rootPath ? `${artifactUri(rootPath)}/` : ""}`
            : undefined;
        const summary = toMarkdown(report, sourceBaseUrl ? { sourceBaseUrl } : {});
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
