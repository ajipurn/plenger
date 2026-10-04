import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareNextRuntime } from "../src/redteam/runtime.ts";

// Developer-only qualification: real SDK/handlers/SQLite, synthetic model, no API credentials.
const root = fileURLToPath(new URL("../", import.meta.url));
const image = await prepareNextRuntime(AbortSignal.timeout(600_000));
console.log(
  JSON.stringify({
    kind: "vercel-runtime-qualification",
    image,
    model: "synthetic",
    liveModelQualified: false,
  }),
);
await new Promise<void>((resolve, reject) => {
  const child = spawn("pnpm", ["exec", "vitest", "run", "test/vercel-run.test.ts"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, PLENGER_TEST_VERCEL_IMAGE: image },
  });
  child.on("error", reject);
  child.on("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`Vercel qualification exited ${code}`)),
  );
});
