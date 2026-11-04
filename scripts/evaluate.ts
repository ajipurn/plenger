// Measures detection on the labeled corpus: the static rules always, and the AI review
// of each saved provider when asked. Developer-only; the CLI never runs it.
// Usage: pnpm evaluate [--provider <name|id>]... [--validator <name|id>] [--model <id>]
//                      [--runs <n>] [--corpus <dir>] [--data-dir <dir>] [--output <file.md>]
//                      [--json <file>] [--mode batch|explore] [--concurrency <n>] [--yes]
//   Without --provider only the static scanner is evaluated, offline.
//   With --provider, redacted corpus source is sent to that connection: up to two model
//   requests per case and run in batch mode, and up to the session limits in explore
//   mode, where the model reads the case through read-only tools. --yes is required.
//   --model reviews with that model of each saved connection instead of its default, for
//   its requests, prices and window; the saved connection is not changed.
//   --concurrency reviews that many cases at a time (default 1). A review the provider
//   rejects with HTTP 429 is rerun after a pause, and the report counts the reruns.
//   --proof runs proof sessions instead (docs/design/proof-tests.md): for each case with
//   a proof label the model writes and runs tests, and the cases' code runs in the proof
//   containers. It needs Docker or Podman and uses PLENGER_TEST_PROOF_PYTHON_IMAGE and
//   PLENGER_TEST_PROOF_NODE_IMAGE when set, or builds the images.

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { EXPLORE_LIMITS, SECURITY_REVIEW_LIMITS } from "../src/assessment/review-model.ts";
import { ModelWindowCatalog } from "../src/dashboard/model-windows.ts";
import { MODEL_ID, PROOF_SESSION_LIMITS } from "../src/redteam/constants.ts";
import { prepareProofRuntime } from "../src/redteam/runtime.ts";
import { ProviderRepository } from "../src/storage/provider-repository.ts";
import {
  type AiConnection,
  type AiEvaluation,
  evaluateAi,
  evaluateStatic,
  formatEvaluation,
  loadCorpus,
} from "./lib/evaluation.ts";
import { evaluateProof, formatProofEvaluation } from "./lib/proof-evaluation.ts";

const { values } = parseArgs({
  // pnpm 10 passes the `--` of `pnpm evaluate -- --provider x` through to the script.
  args: process.argv.slice(2).filter((arg, index) => index > 0 || arg !== "--"),
  options: {
    provider: { type: "string", multiple: true },
    validator: { type: "string" },
    model: { type: "string" },
    runs: { type: "string" },
    corpus: { type: "string" },
    "data-dir": { type: "string" },
    output: { type: "string" },
    json: { type: "string" },
    mode: { type: "string" },
    concurrency: { type: "string" },
    proof: { type: "boolean" },
    yes: { type: "boolean" },
  },
});
const mode = values.mode ?? "batch";
if (mode !== "batch" && mode !== "explore") throw new Error("Use --mode batch or explore.");
const runs = Number(values.runs ?? 3);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) throw new Error("Use --runs 1 to 10.");
const concurrency = Number(values.concurrency ?? 1);
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8)
  throw new Error("Use --concurrency 1 to 8.");
if (values.model !== undefined && (!MODEL_ID.test(values.model) || values.model.includes("://")))
  throw new Error("Use --model with a model id.");
const corpus = values.corpus ?? "test/fixtures/evaluation";
const cases = await loadCorpus(corpus);

if (values.proof) {
  const names = values.provider ?? [];
  if (names.length !== 1) throw new Error("Use --proof with one --provider.");
  const labeled = cases.filter((item) => item.proof !== undefined);
  console.log(
    `Proof sessions: ${labeled.length} cases × ${runs} runs, each at most ${PROOF_SESSION_LIMITS.modelCalls} model requests and ${PROOF_SESSION_LIMITS.tokens.toLocaleString("en-US")} tokens; at most ${(labeled.length * runs * PROOF_SESSION_LIMITS.tokens).toLocaleString("en-US")} tokens in all.`,
  );
  if (!values.yes) {
    console.log(
      "Redacted corpus source would be sent to the provider, and the cases' code would run in the proof containers. Add --yes to run it.",
    );
    process.exit(2);
  }
  const signal = AbortSignal.timeout(1_200_000);
  const images = {
    python:
      process.env.PLENGER_TEST_PROOF_PYTHON_IMAGE ??
      (await prepareProofRuntime("proof-python", signal)),
    javascript:
      process.env.PLENGER_TEST_PROOF_NODE_IMAGE ??
      (await prepareProofRuntime("proof-node", signal)),
  };
  const store = await ProviderRepository.open(values["data-dir"]);
  let report: string;
  let json: unknown;
  try {
    const name = names[0] as string;
    const saved = store.providers
      .readProviders()
      .find((item) => item.id === name || item.name === name);
    if (!saved) throw new Error(`No saved provider named ${name}.`);
    const { access } = store.providers.resolveProvider(saved.id);
    const model = values.model ?? saved.model;
    const evaluation = await evaluateProof(cases, {
      provider: { name: saved.name, model },
      access: { ...access, model },
      images,
      runs,
      onCase: (outcome, run) =>
        console.log(`run ${run} ${outcome.id}: ${outcome.outcome} (${outcome.reason})`),
    });
    report = formatProofEvaluation(evaluation, new Date().toISOString().slice(0, 10));
    json = evaluation;
  } finally {
    store.close();
  }
  if (values.json) await writeFile(values.json, `${JSON.stringify(json, null, 2)}\n`);
  if (values.output) {
    await writeFile(values.output, report);
    console.log(`wrote ${values.output}`);
  } else console.log(report);
  process.exit(0);
}

const staticOutcomes = await evaluateStatic(cases);

const evaluations: AiEvaluation[] = [];
const names = values.provider ?? [];
if (names.length) {
  const perReview =
    mode === "explore"
      ? EXPLORE_LIMITS.discovery.modelCalls + EXPLORE_LIMITS.validation.modelCalls
      : SECURITY_REVIEW_LIMITS.calls;
  const calls = names.length * cases.length * runs * perReview;
  console.log(
    `AI review: ${names.length} ${names.length === 1 ? "provider" : "providers"} × ${cases.length} cases × ${runs} runs, at most ${calls} model requests.`,
  );
  if (!values.yes) {
    console.log("Redacted corpus source would be sent to the provider. Add --yes to run it.");
    process.exit(2);
  }
  const store = await ProviderRepository.open(values["data-dir"]);
  try {
    // Rounds are sized as a dashboard scan sizes them.
    const windows = new ModelWindowCatalog(store.providers);
    const connection = async (name: string): Promise<AiConnection> => {
      const saved = store.providers
        .readProviders()
        .find((item) => item.id === name || item.name === name);
      if (!saved) throw new Error(`No saved provider named ${name}.`);
      const { access } = store.providers.resolveProvider(saved.id);
      const model = values.model ?? saved.model;
      const pricing = saved.modelPricing?.find((item) => item.model === model);
      return {
        provider: { id: saved.id, name: saved.name, model },
        access: { ...access, model },
        ...(pricing ? { pricing } : {}),
        inputTokens: await windows.forScan(saved, access.apiKey, model),
      };
    };
    const validator = values.validator ? await connection(values.validator) : undefined;
    for (const name of names) {
      evaluations.push(
        await evaluateAi(cases, {
          connection: await connection(name),
          ...(validator ? { validator } : {}),
          runs,
          mode,
          concurrency,
          onReview: (item, run, outcome) =>
            console.log(
              `run ${run} ${item.id}: ${outcome.status}${outcome.detected ? ", detected" : ""}`,
            ),
        }),
      );
    }
  } finally {
    store.close();
  }
}

const report = formatEvaluation(
  cases,
  staticOutcomes,
  evaluations,
  new Date().toISOString().slice(0, 10),
  corpus,
);
if (values.json) {
  const json = { static: staticOutcomes, ai: evaluations };
  await writeFile(values.json, `${JSON.stringify(json, null, 2)}\n`);
}
if (values.output) {
  await writeFile(values.output, report);
  console.log(`wrote ${values.output}`);
} else console.log(report);
