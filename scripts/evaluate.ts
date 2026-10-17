// Measures detection on the labeled corpus: the static rules always, and the AI review
// of each saved provider when asked. Developer-only; the CLI never runs it.
// Usage: pnpm evaluate [--provider <name|id>]... [--validator <name|id>] [--runs <n>]
//                      [--corpus <dir>] [--data-dir <dir>] [--output <file.md>]
//                      [--json <file>] [--mode batch|explore] [--yes]
//   Without --provider only the static scanner is evaluated, offline.
//   With --provider, redacted corpus source is sent to that connection: up to two model
//   requests per case and run in batch mode, and up to the session limits in explore
//   mode, where the model reads the case through read-only tools. --yes is required.

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { EXPLORE_LIMITS, SECURITY_REVIEW_LIMITS } from "../src/assessment/review-model.ts";
import { ProviderRepository } from "../src/storage/provider-repository.ts";
import {
  type AiConnection,
  type AiEvaluation,
  evaluateAi,
  evaluateStatic,
  formatEvaluation,
  loadCorpus,
} from "./lib/evaluation.ts";

const { values } = parseArgs({
  // pnpm 10 passes the `--` of `pnpm evaluate -- --provider x` through to the script.
  args: process.argv.slice(2).filter((arg, index) => index > 0 || arg !== "--"),
  options: {
    provider: { type: "string", multiple: true },
    validator: { type: "string" },
    runs: { type: "string" },
    corpus: { type: "string" },
    "data-dir": { type: "string" },
    output: { type: "string" },
    json: { type: "string" },
    mode: { type: "string" },
    yes: { type: "boolean" },
  },
});
const mode = values.mode ?? "batch";
if (mode !== "batch" && mode !== "explore") throw new Error("Use --mode batch or explore.");
const runs = Number(values.runs ?? 3);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) throw new Error("Use --runs 1 to 10.");
const cases = await loadCorpus(values.corpus ?? "test/fixtures/evaluation");
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
    const connection = (name: string): AiConnection => {
      const saved = store.providers
        .readProviders()
        .find((item) => item.id === name || item.name === name);
      if (!saved) throw new Error(`No saved provider named ${name}.`);
      const { access } = store.providers.resolveProvider(saved.id);
      const pricing = saved.modelPricing?.find((item) => item.model === saved.model);
      return {
        provider: { id: saved.id, name: saved.name, model: saved.model },
        access,
        ...(pricing ? { pricing } : {}),
        inputTokens: store.providers.modelInputTokens(saved, access.apiKey, saved.model),
      };
    };
    const validator = values.validator ? connection(values.validator) : undefined;
    for (const name of names) {
      evaluations.push(
        await evaluateAi(cases, {
          connection: connection(name),
          ...(validator ? { validator } : {}),
          runs,
          mode,
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
);
if (values.json) {
  const json = { static: staticOutcomes, ai: evaluations };
  await writeFile(values.json, `${JSON.stringify(json, null, 2)}\n`);
}
if (values.output) {
  await writeFile(values.output, report);
  console.log(`wrote ${values.output}`);
} else console.log(report);
