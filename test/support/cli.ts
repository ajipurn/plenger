import { main } from "../../src/cli/index.ts";
import type { Updates } from "../../src/cli/update.ts";

export async function captureCli(argv: string[], updates?: Updates) {
  let stdout = "";
  let stderr = "";
  const code = await main(
    argv,
    {
      color: false,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    updates,
  );
  return { code, stdout, stderr };
}
