import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The repository root, where developer scripts run their commands. */
export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Run a command with inherited stdio; rejects when it exits non-zero. */
export async function command(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { cwd: repositoryRoot, stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${program} exited ${code}`)),
    );
  });
}
