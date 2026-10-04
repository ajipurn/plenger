import { type BudgetLimits, validateBudgetLimits } from "../../redteam/budget.ts";
import {
  type CampaignPlan,
  type CampaignPolicy,
  createCampaignPlan,
  interruptCampaign,
  newCampaign,
} from "../../redteam/campaign.ts";
import { PreparationError, type ProjectPlan, planProject } from "../../redteam/plan.ts";
import {
  createRunProvider,
  type ProviderAccess,
  type RunProvider,
} from "../../redteam/provider.ts";
import { isProviderId, providerConfigFromSaved } from "../../redteam/provider-config.ts";
import {
  interruptRun,
  newRun,
  type RedteamRun,
  type RunOptions,
  validateRunPlan,
} from "../../redteam/run.ts";
import { isRecord } from "../../shared/guards.ts";
import type { ResolvedProvider } from "../../storage/store.ts";
import {
  API,
  CAMPAIGN_LIMITS,
  type CancelResult,
  type Range,
  RUN_LIMITS,
  type SavedRunProfile,
} from "../contract.ts";
import {
  expectKeys,
  getById,
  HttpError,
  jsonRequest,
  type Reply,
  requireInt,
  requireString,
} from "../http.ts";
import type { Route } from "../router.ts";
import type { Services } from "../services.ts";
import { resolveDirectory } from "../workspace.ts";

type StartKind = "run" | "campaign";

const START_MESSAGE = "Review a supported target and configure model access before starting.";
const PROVIDER_MESSAGE = "Check your provider, model ID and API key.";
const CAMPAIGN_SETTINGS_MESSAGE = "Check campaign repetitions and coverage requirements.";
const LIMIT_MESSAGES: Record<StartKind, string> = {
  run: "Use 1–30 model calls, up to 2000000 tokens and a 1–600 second deadline.",
  campaign: "Use 1–1200 model calls, up to 50000000 tokens and a 1–3600 second campaign deadline.",
};
const START_KEYS = [
  "path",
  "target",
  "sourceDigest",
  "provider",
  "model",
  "apiKey",
  "limits",
  "providerId",
];
const CAMPAIGN_KEYS = [...START_KEYS, "repetitions", "policy"];
const LIMIT_KEYS: (keyof BudgetLimits)[] = ["maxModelCalls", "maxTokens", "timeoutMs"];
const SOURCE_DIGEST = /^[a-f0-9]{64}$/;

/** A validated start request before anything on disk or on the network is touched. */
interface StartRequest {
  path: string;
  target: string;
  sourceDigest: string;
  limits: BudgetLimits;
  selection: { providerId: string } | ProviderAccess;
  repetitions?: number;
  /** Shape-checked here; `createCampaignPlan` validates its contents. */
  policy?: Partial<CampaignPolicy>;
}

/** Model access for this start: ad hoc, or a saved connection with its unsealed key. */
interface SelectedProvider {
  provider: RunProvider;
  access: ProviderAccess;
  saved?: ResolvedProvider["saved"];
}

export function redteamRoutes(services: Services): Route[] {
  const { store, supervisor, workspace } = services;
  async function start(
    kind: StartKind,
    request: Parameters<typeof jsonRequest>[0],
  ): Promise<Reply> {
    const body = await jsonRequest(request);
    supervisor.assertIdle();
    const parsed = parseStartRequest(body, kind);
    const selected = resolveProvider(services, parsed.selection);
    return supervisor.exclusive(async () => {
      const path = await resolveDirectory(parsed.path, workspace);
      const plan = await prepareVerifiedPlan(path, parsed.target, parsed.sourceDigest);
      return kind === "campaign"
        ? startCampaign(services, parsed, plan, selected)
        : startRun(services, parsed, path, plan, selected);
    });
  }
  return [
    {
      method: "GET",
      path: API.run,
      handler: ({ url }) => ({
        status: 200,
        body: getById(url, (id) => store.readRun(id), {
          choose: "Choose a run.",
          notFound: "Run not found.",
        }),
      }),
    },
    {
      method: "GET",
      path: API.campaign,
      handler: ({ url }) => ({
        status: 200,
        body: getById(url, (id) => store.readCampaign(id), {
          choose: "Choose a campaign.",
          notFound: "Campaign not found.",
        }),
      }),
    },
    {
      method: "POST",
      path: API.cancel,
      handler: async ({ request }) => {
        const body = await jsonRequest(request);
        // A malformed body names no active run either, so it gets the same 409.
        const id =
          typeof body.id === "string" && Object.keys(body).every((key) => key === "id")
            ? body.id
            : null;
        supervisor.cancel(id);
        const result: CancelResult = { cancelled: true };
        return { status: 202, body: result };
      },
    },
    { method: "POST", path: API.startRun, handler: ({ request }) => start("run", request) },
    {
      method: "POST",
      path: API.startCampaign,
      handler: ({ request }) => start("campaign", request),
    },
  ];
}

export function parseStartRequest(body: Record<string, unknown>, kind: StartKind): StartRequest {
  expectKeys(body, kind === "campaign" ? CAMPAIGN_KEYS : START_KEYS, START_MESSAGE);
  const path = requireString(body.path, START_MESSAGE);
  const target = requireString(body.target, START_MESSAGE);
  const sourceDigest = requireString(body.sourceDigest, START_MESSAGE);
  if (!SOURCE_DIGEST.test(sourceDigest)) throw new HttpError(400, START_MESSAGE);
  if (body.apiKey !== undefined && typeof body.apiKey !== "string")
    throw new HttpError(400, START_MESSAGE);
  let selection: StartRequest["selection"];
  if (body.providerId !== undefined) {
    if (["provider", "model", "apiKey"].some((key) => key in body))
      throw new HttpError(400, START_MESSAGE);
    selection = { providerId: requireString(body.providerId, START_MESSAGE) };
  } else {
    if (!isProviderId(body.provider)) throw new HttpError(400, START_MESSAGE);
    selection = {
      provider: body.provider,
      model: requireString(body.model, START_MESSAGE),
      ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
    };
  }
  const limits = parseLimits(body.limits, kind);
  const request: StartRequest = { path, target, sourceDigest, limits, selection };
  if (kind !== "campaign") return request;
  if (body.repetitions !== undefined)
    request.repetitions = requireInt(
      body.repetitions,
      CAMPAIGN_LIMITS.repetitions.min,
      CAMPAIGN_LIMITS.repetitions.max,
      CAMPAIGN_SETTINGS_MESSAGE,
    );
  if (body.policy !== undefined) {
    if (!isRecord(body.policy)) throw new HttpError(400, CAMPAIGN_SETTINGS_MESSAGE);
    // Only the shape is known here; `createCampaignPlan` rejects invalid contents (400 below).
    request.policy = body.policy as Partial<CampaignPolicy>;
  }
  return request;
}

function parseLimits(value: unknown, kind: StartKind): BudgetLimits {
  const message = LIMIT_MESSAGES[kind];
  const ceilings: Record<keyof BudgetLimits, Range> =
    kind === "campaign" ? CAMPAIGN_LIMITS : RUN_LIMITS;
  if (!isRecord(value)) throw new HttpError(400, message);
  expectKeys(value, LIMIT_KEYS, message);
  const limits: BudgetLimits = {
    maxModelCalls: requireInt(
      value.maxModelCalls,
      ceilings.maxModelCalls.min,
      ceilings.maxModelCalls.max,
      message,
    ),
    maxTokens: requireInt(value.maxTokens, ceilings.maxTokens.min, ceilings.maxTokens.max, message),
    timeoutMs: requireInt(value.timeoutMs, ceilings.timeoutMs.min, ceilings.timeoutMs.max, message),
  };
  try {
    validateBudgetLimits(limits);
  } catch (error) {
    throw new HttpError(400, message, { cause: error });
  }
  return limits;
}

/** Build the engine's provider; the saved key (if any) lives only in this request. */
function resolveProvider(
  { store }: Services,
  selection: StartRequest["selection"],
): SelectedProvider {
  try {
    if (!("providerId" in selection))
      return { provider: createRunProvider(selection), access: selection };
    const { saved, access } = store.resolveProvider(selection.providerId);
    return { provider: createRunProvider(access), access, saved };
  } catch (error) {
    // Deleted connections, unreadable keys and invalid ad hoc settings all read the same.
    throw new HttpError(400, PROVIDER_MESSAGE, { cause: error });
  }
}

/** Re-plan the target and insist the source is what the page reviewed. */
export async function prepareVerifiedPlan(
  path: string,
  target: string,
  sourceDigest: string,
): Promise<ProjectPlan> {
  let plan: ProjectPlan;
  try {
    plan = await planProject(path, { target });
  } catch (error) {
    if (error instanceof PreparationError)
      throw new HttpError(400, "Select a supported candidate from a fresh project review.", {
        cause: error,
      });
    throw error;
  }
  try {
    validateRunPlan(plan);
  } catch (error) {
    throw new HttpError(
      400,
      "This target is outside the supported llmfy file-test or Next.js booking/SQLite runtime profile. Review the preparation details.",
      { cause: error },
    );
  }
  if (plan.sourceDigest !== sourceDigest)
    throw new HttpError(409, "Project changed since review. Refresh the plan before starting.");
  return plan;
}

function runProfile(request: StartRequest, selected: SelectedProvider): SavedRunProfile {
  return {
    target: request.target,
    provider: selected.access.provider,
    model: selected.access.model,
    ...(selected.saved ? { providerId: selected.saved.id } : {}),
    limits: request.limits,
  };
}

function startCampaign(
  { store, supervisor, campaignExecutor }: Services,
  request: StartRequest,
  plan: ProjectPlan,
  selected: SelectedProvider,
): Reply {
  let campaignPlan: CampaignPlan;
  try {
    campaignPlan = createCampaignPlan(plan, {
      provider: selected.access.provider,
      model: selected.access.model,
      limits: request.limits,
      ...(selected.saved ? { providerConfig: providerConfigFromSaved(selected.saved) } : {}),
      ...(request.repetitions === undefined ? {} : { repetitions: request.repetitions }),
      ...(request.policy === undefined ? {} : { policy: request.policy }),
    });
  } catch (error) {
    throw new HttpError(
      400,
      "Check campaign repetitions (1–100), severity and coverage requirements.",
      { cause: error },
    );
  }
  const report = newCampaign(campaignPlan);
  const controller = new AbortController();
  store.saveCampaign(report, {
    ...runProfile(request, selected),
    repetitions: report.plan.repetitions,
    policy: report.plan.policy,
  });
  const task = campaignExecutor(report, selected.provider, {
    signal: controller.signal,
    onUpdate: (snapshot) => store.saveCampaign(snapshot),
  }).catch(() => {
    // The executor reports its own failures in the report; this only covers a crash
    // before it could. The page sees the saved state, not the exception.
    interruptCampaign(report, "Campaign failed before cleanup could be confirmed.", {
      state: "failed",
    });
    store.saveCampaign(report);
  });
  supervisor.track(report.id, controller, task);
  return { status: 202, body: report };
}

function startRun(
  { store, supervisor, runExecutor }: Services,
  request: StartRequest,
  path: string,
  plan: ProjectPlan,
  selected: SelectedProvider,
): Reply {
  const controller = new AbortController();
  const runOptions: RunOptions = {
    ...(plan.nextProfile ? { profile: plan.nextProfile.id } : {}),
    target: request.target,
    sourceDigest: request.sourceDigest,
    limits: request.limits,
    provider: selected.provider,
    signal: controller.signal,
    onUpdate: (snapshot: RedteamRun) => store.saveRun(snapshot),
  };
  const run = newRun(path, runOptions);
  if (selected.saved) run.providerConfig = providerConfigFromSaved(selected.saved);
  store.saveRun(run, runProfile(request, selected));
  const task = runExecutor(run, runOptions).catch(() => {
    // As for campaigns: a crash before the executor's own bookkeeping ran.
    interruptRun(run, "Run failed before cleanup could be confirmed.", { state: "failed" });
    store.saveRun(run);
  });
  supervisor.track(run.id, controller, task);
  return { status: 202, body: run };
}
