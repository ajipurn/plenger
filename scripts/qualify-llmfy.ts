import { qualifyLlmfy, qualifyLlmfyBudget } from "../src/redteam/qualification.ts";
import { prepareLlmfyRuntime } from "../src/redteam/runtime.ts";
import { command } from "./lib/spawn.ts";

// Developer-only, opt-in integration check. The static CLI never calls this.
const image = await prepareLlmfyRuntime(AbortSignal.timeout(120_000));
const report = await qualifyLlmfy(image);
console.log(JSON.stringify({ image, ...report }, null, 2));
const budgetReport = await qualifyLlmfyBudget(image, {
  limits: { maxModelCalls: 9, maxTokens: 100_000, timeoutMs: 30_000 },
});
console.log(JSON.stringify({ image, ...budgetReport }, null, 2));
await command(
  "pnpm",
  ["exec", "vitest", "run", "test/redteam-runtime.test.ts", "test/redteam-worker.test.ts"],
  { ...process.env, PLENGER_TEST_LLMFY_IMAGE: image },
);
