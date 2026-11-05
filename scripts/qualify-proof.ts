import { prepareProofRuntime } from "../src/redteam/runtime.ts";
import { command } from "./lib/spawn.ts";

// Developer-only: builds both proof images and runs the handwritten and adversarial
// proof tests in them. No model and no API credentials.
const signal = AbortSignal.timeout(1_200_000);
const python = await prepareProofRuntime("proof-python", signal);
const node = await prepareProofRuntime("proof-node", signal);
console.log(JSON.stringify({ kind: "proof-runtime-qualification", python, node, model: null }));
await command("pnpm", ["exec", "vitest", "run", "test/proof-runtime.test.ts"], {
  ...process.env,
  PLENGER_TEST_PROOF_PYTHON_IMAGE: python,
  PLENGER_TEST_PROOF_NODE_IMAGE: node,
});
