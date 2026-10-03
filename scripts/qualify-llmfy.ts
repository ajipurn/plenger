import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { qualifyLlmfy, qualifyLlmfyBudget } from "../src/redteam/qualification.ts";

// Developer-only, opt-in integration check. The static CLI never calls this.
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "plenger-build-"));
try {
  const iidfile = join(directory, "image-id");
  await command("podman", [
    "build",
    "--platform=linux/arm64",
    "--iidfile",
    iidfile,
    join(root, "runtimes/llmfy"),
  ]);
  const image = (await readFile(iidfile, "utf8")).trim();
  const report = await qualifyLlmfy(image);
  console.log(JSON.stringify({ image, ...report }, null, 2));
  const budgetReport = await qualifyLlmfyBudget(image, {
    limits: { maxModelCalls: 9, maxTokens: 100_000, timeoutMs: 30_000 },
  });
  console.log(JSON.stringify({ image, ...budgetReport }, null, 2));
  await command("pnpm", ["exec", "vitest", "run", "test/redteam-runtime.test.ts"], {
    ...process.env,
    PLENGER_TEST_LLMFY_IMAGE: image,
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function command(program: string, args: string[], env = process.env): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${program} exited ${code}`)),
    );
  });
}
