import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readJsonFile, writeCampaignArtifact } from "../../redteam/artifact-io.ts";
import {
  type CampaignPlan,
  type CampaignReport,
  createCampaignPlan,
  executeCampaign,
  newCampaign,
  validateCampaignPlan,
} from "../../redteam/campaign.ts";
import { type CampaignFormat, formatCampaign } from "../../redteam/campaign-report.ts";
import { CLI_DEFAULT_LIMITS, REPETITION_RANGE } from "../../redteam/constants.ts";
import { planProject } from "../../redteam/plan.ts";
import { createRunProvider, type ProviderAccess } from "../../redteam/provider.ts";
import {
  accessFromProviderConfig,
  type ProviderConfig,
  providerConfigFromSaved,
  type SavedProvider,
} from "../../redteam/provider-config.ts";
import { SEVERITIES, type Severity } from "../../rules/model.ts";
import { errorMessage, isErrno } from "../../shared/guards.ts";
import { json } from "../../shared/json.ts";
import { redact } from "../../shared/secrets.ts";
import { ProviderRepository } from "../../storage/provider-repository.ts";
import type { Io } from "../io.ts";

export const REDTEAM_RUN_USAGE = `Usage:
  plenger redteam run [path] --provider <saved name or id>
  plenger redteam run [path] --profile <campaign-plan.json> [--api-key-env <name>]

Run the selected agent in the managed test runtime. Configure model connections
in the dashboard's Providers page. With no --provider, use the saved default.

Options:
  --target <id>           Target from redteam plan (automatic when unambiguous)
  --provider <name|id>    Saved provider connection
  --data-dir <folder>    Provider store location (same as plenger serve)
  --profile <file>       Reuse an exported plan; optional path relocates its checkout
  --refresh-source       Review new source bytes with the profile's required scope
  --write-profile <file> Export the non-secret campaign plan for reruns and CI
  --api-key-env <name>   Read the chosen environment variable, never a project .env
  --repeat <${REPETITION_RANGE.min}-${REPETITION_RANGE.max}>       Fixed repetitions with fresh workers (default: 1)
  --calls <count>        Model call cap for the entire campaign (default: ${CLI_DEFAULT_LIMITS.calls})
  --tokens <count>       Token budget for the entire campaign (default: ${CLI_DEFAULT_LIMITS.tokens})
  --timeout <seconds>    Deadline for the entire campaign (default: ${CLI_DEFAULT_LIMITS.timeoutSeconds})
  --fail-on <severity>   critical, high, medium, low or none (default: none)
  --min-coverage <ratio> Minimum evaluable fraction per case, >0 through 1 (default: 1)
  --minimum-evaluable <n> Minimum count per case (default: 1; comparisons require 20)
  --format <format>      terminal, json, markdown or sarif (default: terminal)
  --output <file>        Report destination; private JSON evidence is always saved
                         in <project>/.plenger/runs/. Exclude .plenger/ from Git.

API keys are excluded from profiles and reports. Each result covers its selected
runtime profile and scope. Exit: 0 gate passed; 1 execution/coverage/scope failure;
2 invalid configuration; 3 observed severity threshold, even after interruption.
`;

const PROFILE_MAX_BYTES = 1024 * 1024;
const PLAN_FIXED_OPTIONS = [
  "target",
  "repeat",
  "calls",
  "tokens",
  "timeout",
  "fail-on",
  "min-coverage",
  "minimum-evaluable",
] as const;
const FORMATS: CampaignFormat[] = ["terminal", "json", "markdown", "sarif"];

/** Validated command-line inputs, before any store, file or project access. */
interface RunArgs {
  project: string | undefined;
  provider: string | undefined;
  target: string | undefined;
  dataDir: string | undefined;
  profile: string | undefined;
  refreshSource: boolean;
  apiKeyEnv: string | undefined;
  format: CampaignFormat;
  destination: string | undefined;
  profileOutput: string | undefined;
  repeat: number;
  limits: { maxModelCalls: number; maxTokens: number; timeoutMs: number };
  policy: { failOn: Severity | "none"; minCoverage: number; minimumEvaluable: number };
}

/** `plenger redteam run`: exit 0 gate passed, 1 execution failure, 2 configuration, 3 findings. */
export async function redteamRunCommand(argv: string[], io: Io): Promise<number> {
  let plan: CampaignPlan;
  let access: ProviderAccess;
  let args: RunArgs;
  try {
    const parsed = parseRunArgs(argv);
    if (parsed === "help") {
      io.stdout(REDTEAM_RUN_USAGE);
      return 0;
    }
    args = parsed;
    const imported = args.profile ? await loadImportedProfile(args) : undefined;
    const resolved = await resolveAccess(args, imported);
    access = resolved.access;
    plan = imported ?? (await buildCampaignPlan(args, access, resolved.saved));
    createRunProvider(access);
  } catch (error) {
    io.stderr(`plenger: ${redact(errorMessage(error) || "Invalid red-team configuration.")}\n`);
    return 2;
  }
  return runWithEvidence(plan, access, args, io);
}

function parseRunArgs(argv: string[]): RunArgs | "help" {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      provider: { type: "string" },
      target: { type: "string" },
      "data-dir": { type: "string" },
      profile: { type: "string" },
      "write-profile": { type: "string" },
      "api-key-env": { type: "string" },
      "refresh-source": { type: "boolean" },
      repeat: { type: "string" },
      calls: { type: "string" },
      tokens: { type: "string" },
      timeout: { type: "string" },
      "fail-on": { type: "string" },
      "min-coverage": { type: "string" },
      "minimum-evaluable": { type: "string" },
      format: { type: "string" },
      json: { type: "boolean" },
      output: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return "help";
  if (positionals.length > 1 || Object.values(values).some((value) => value === ""))
    throw new Error("Use one project folder and nonempty option values.");
  const format = (values.format ?? (values.json ? "json" : "terminal")) as CampaignFormat;
  if (!FORMATS.includes(format) || (values.json && format !== "json"))
    throw new Error("Choose one report format: terminal, json, markdown or sarif.");
  const destination = values.output ? resolve(values.output) : undefined;
  const profileOutput = values["write-profile"] ? resolve(values["write-profile"]) : undefined;
  if (destination && destination === profileOutput)
    throw new Error("Use separate report and profile output files.");
  if (values["refresh-source"] && !values.profile)
    throw new Error("--refresh-source requires an imported campaign profile.");
  if (values.profile && PLAN_FIXED_OPTIONS.some((key) => values[key] !== undefined))
    throw new Error(
      "An imported profile fixes the target, cases, repetitions, budgets and gate. Export a new profile to change them.",
    );
  if (values["api-key-env"] && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(values["api-key-env"]))
    throw new Error("Use an environment variable name for --api-key-env.");
  const failOn = values["fail-on"] ?? "none";
  if (![...SEVERITIES, "none"].includes(failOn as Severity | "none"))
    throw new Error("Choose critical, high, medium, low or none for --fail-on.");
  return {
    project: positionals[0],
    provider: values.provider,
    target: values.target,
    dataDir: values["data-dir"],
    profile: values.profile,
    refreshSource: values["refresh-source"] === true,
    apiKeyEnv: values["api-key-env"],
    format,
    destination,
    profileOutput,
    repeat: number(values.repeat, 1),
    limits: {
      maxModelCalls: number(values.calls, CLI_DEFAULT_LIMITS.calls),
      maxTokens: number(values.tokens, CLI_DEFAULT_LIMITS.tokens),
      timeoutMs: number(values.timeout, CLI_DEFAULT_LIMITS.timeoutSeconds) * 1000,
    },
    policy: {
      failOn: failOn as Severity | "none",
      minCoverage: number(values["min-coverage"], 1),
      minimumEvaluable: number(values["minimum-evaluable"], 1),
    },
  };
}

/** An exported plan, re-planned against the (possibly relocated) checkout it describes. */
async function loadImportedProfile(args: RunArgs): Promise<CampaignPlan> {
  const file = resolve(args.profile as string);
  if (args.destination === file || args.profileOutput === file)
    throw new Error("Do not overwrite the imported profile.");
  const imported = (await readJsonFile(
    file,
    PROFILE_MAX_BYTES,
    "Campaign profile",
  )) as CampaignPlan;
  validateCampaignPlan(imported);
  const fresh = await planProject(args.project ?? imported.root, { target: imported.target });
  if (args.refreshSource)
    return createCampaignPlan(fresh, {
      provider: imported.provider,
      model: imported.model,
      ...(imported.providerConfig ? { providerConfig: imported.providerConfig } : {}),
      limits: imported.limits,
      repetitions: imported.repetitions,
      caseIds: imported.cases.map((item) => item.id),
      policy: imported.policy,
      requiredScope: imported.requiredScope,
      ...(imported.build ? { build: imported.build } : {}),
    });
  if (fresh.sourceDigest !== imported.sourceDigest)
    throw new Error(
      "Source changed since profile export. Use --refresh-source to review it while retaining required scope.",
    );
  imported.root = fresh.root;
  return imported;
}

/** The only place the command touches the provider store. */
async function resolveSavedProvider(
  dataDir: string | undefined,
  reference: string | undefined,
): Promise<{ saved: SavedProvider; access: ProviderAccess }> {
  const store = await ProviderRepository.open(dataDir);
  try {
    const providers = store.providers.readProviders();
    const connection = reference
      ? providers.find((item) => item.id === reference || item.name === reference)
      : providers.find((item) => item.isDefault);
    if (!connection)
      throw new Error(
        "Choose a saved provider with --provider, or add a default in the dashboard's Providers page.",
      );
    return store.providers.resolveProvider(connection.id);
  } finally {
    store.close();
  }
}

/** Model access from the saved connection or the imported profile, plus an optional CI key. */
async function resolveAccess(
  args: RunArgs,
  imported: CampaignPlan | undefined,
): Promise<{ access: ProviderAccess; saved: SavedProvider | undefined }> {
  let access: ProviderAccess;
  let saved: SavedProvider | undefined;
  if (args.provider || !imported || (args.dataDir && !args.apiKeyEnv)) {
    const resolved = await resolveSavedProvider(
      args.dataDir,
      args.provider ?? imported?.providerConfig?.id,
    );
    access = resolved.access;
    saved = resolved.saved;
  } else {
    const config = imported.providerConfig;
    if (!config)
      throw new Error("The imported profile needs non-secret provider connection settings.");
    access = accessFromProviderConfig({
      ...config,
      provider: imported.provider,
      model: imported.model,
    });
  }
  if (args.apiKeyEnv) {
    const key = process.env[args.apiKeyEnv];
    if (!key) throw new Error("The selected API key environment variable is empty or unavailable.");
    access.apiKey = key;
  }
  if (imported && !matchesProfile(access, imported))
    throw new Error(
      "The selected connection does not match the exported model and generation settings.",
    );
  return { access, saved };
}

function matchesProfile(access: ProviderAccess, plan: CampaignPlan): boolean {
  const config: ProviderConfig | undefined = plan.providerConfig;
  return (
    access.provider === plan.provider &&
    access.model === plan.model &&
    (!config ||
      (access.baseUrl === config.baseUrl &&
        access.temperature === config.temperature &&
        access.maxOutputTokens === config.maxOutputTokens))
  );
}

async function buildCampaignPlan(
  args: RunArgs,
  access: ProviderAccess,
  saved: SavedProvider | undefined,
): Promise<CampaignPlan> {
  const project = await planProject(
    args.project ?? ".",
    args.target ? { target: args.target } : {},
  );
  return createCampaignPlan(project, {
    provider: access.provider,
    model: access.model,
    ...(saved ? { providerConfig: providerConfigFromSaved(saved) } : {}),
    repetitions: args.repeat,
    limits: args.limits,
    policy: args.policy,
  });
}

/** `<project>/.plenger/runs/`, created private and refused when a link stands in its place. */
async function prepareEvidenceDir(root: string): Promise<string> {
  const runs = join(root, ".plenger", "runs");
  for (const folder of [join(root, ".plenger"), runs]) {
    try {
      await mkdir(folder, { mode: 0o700 });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    if (!(await lstat(folder)).isDirectory())
      throw new Error("Evidence folders must be regular directories, not symlinks.");
  }
  return runs;
}

/** Execute the campaign while every snapshot is persisted atomically as private evidence. */
async function runWithEvidence(
  plan: CampaignPlan,
  access: ProviderAccess,
  args: RunArgs,
  io: Io,
): Promise<number> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const report = newCampaign(plan);
  try {
    const artifact = join(await prepareEvidenceDir(plan.root), `${report.id}.json`);
    if (args.destination === artifact || args.profileOutput === artifact)
      throw new Error("Choose a different output destination from the campaign evidence file.");
    if (args.profileOutput) await writeCampaignArtifact(args.profileOutput, json(plan));
    await writeCampaignArtifact(artifact, formatCampaign(report, "json"));
    let pendingWrite = Promise.resolve();
    let storageFailed = false;
    await executeCampaign(report, createRunProvider(access), {
      signal: controller.signal,
      onUpdate: (snapshot: CampaignReport) => {
        const text = formatCampaign(snapshot, "json");
        pendingWrite = pendingWrite
          .then(() => writeCampaignArtifact(artifact, text))
          .catch(() => {
            storageFailed = true;
            controller.abort();
          });
      },
    });
    await pendingWrite;
    if (storageFailed) throw new Error("Could not save campaign evidence; testing stopped.");
    const output = formatCampaign(report, args.format);
    if (args.destination) await writeCampaignArtifact(args.destination, output);
    else io.stdout(output);
    io.stderr(`plenger: campaign evidence saved in ${artifact}\n`);
    return report.gate.exitCode;
  } catch {
    io.stderr(
      "plenger: red-team execution or evidence storage failed. Check the managed runtime and output folder.\n",
    );
    return report.gate.exitCode === 3 ? 3 : 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

function number(input: string | undefined, fallback: number): number {
  if (input === undefined) return fallback;
  if (!/^\d+(?:\.\d+)?$/.test(input))
    throw new Error("Budget and repetition options must be positive numbers.");
  return Number(input);
}
