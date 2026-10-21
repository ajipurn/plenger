import { runGitHubAction } from "./lib/github-action.ts";

process.exitCode = await runGitHubAction();
