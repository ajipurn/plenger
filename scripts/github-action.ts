import { runGitHubAction } from "../src/report/github.ts";

process.exitCode = await runGitHubAction();
