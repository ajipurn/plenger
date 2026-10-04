import { prepareVercelRuntime } from "../src/redteam/runtime.ts";
import { command } from "./lib/spawn.ts";

// Developer-only qualification: real SDK/handlers/SQLite, synthetic model, no API credentials.
const image = await prepareVercelRuntime(AbortSignal.timeout(600_000));
console.log(
  JSON.stringify({
    kind: "vercel-runtime-qualification",
    image,
    model: "synthetic",
    liveModelQualified: false,
  }),
);
await command("pnpm", ["exec", "vitest", "run", "test/redteam-vercel-run.test.ts"], {
  ...process.env,
  PLENGER_TEST_VERCEL_IMAGE: image,
});
