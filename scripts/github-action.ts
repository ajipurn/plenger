import { runGitHubAction } from "../src/cli/commands/github-action.ts";

process.exitCode = await runGitHubAction();
