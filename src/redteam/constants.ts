/**
 * Single source for the red-team contracts: identifiers, limits and runtime pins.
 * `schema.ts` derives its enums and bounds from these so the JSON schemas cannot drift.
 */

/** Order matters: it is the enum order in the published campaign plan schema. */
export const PROVIDERS = ["openai", "gemini", "ollama", "chatgpt", "anthropic"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const ANTHROPIC = {
  version: "2023-06-01",
  maxTemperature: 1,
  refusalTextLimit: 2000,
} as const;

export const CHATGPT = {
  issuer: "https://auth.openai.com",
  authorize: "https://auth.openai.com/api/accounts/authorize",
  token: "https://auth.openai.com/api/accounts/oauth/token",
  jwks: "https://auth.openai.com/.well-known/jwks.json",
  resource: "https://api.openai.com/v1",
  usageUrl: "https://chatgpt.com/settings/usage",
  scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  dynamicClient: "dynamic_agent_client",
  callbackPath: "/auth/callback",
  loginTimeoutMs: 300_000,
  requestTimeoutMs: 20_000,
  /** Catalogs include capabilities and metadata for many models. */
  modelCatalogByteCap: 4 * 1024 * 1024,
} as const;

/** Model identifiers never carry a URL; `://` is rejected separately. */
export const MODEL_ID = /^[\w./:-]{1,128}$/;
export const MAX_OUTPUT_TOKENS = 16384;
export const TEMPERATURE_RANGE = { min: 0, max: 2 } as const;
export const API_KEY_MAX_LENGTH = 4096;
export const API_KEY_PREVIEW = {
  mask: "••••••••••••",
  suffixLength: 4,
  minimumLength: 12,
} as const;
export const PROVIDER_MODEL_LIMITS = {
  timeoutMs: 20_000,
  bytes: 4 * 1024 * 1024,
  pageSize: 100,
  pages: 10,
  models: 1000,
  nameLength: 160,
} as const;

/** An immutable image ID, optionally prefixed for the Docker engine. */
export const IMAGE_ID = /^(?:docker:)?sha256:[a-f0-9]{64}$/;
/** Captured source bytes a managed runtime accepts per run. */
export const SOURCE_BYTE_CAP = 4 * 1024 * 1024;
/** Serialised model request/response sizes the bounded transport accepts. */
export const MODEL_REQUEST_CAP = 48 * 1024;
export const MODEL_RESPONSE_CAP = 64 * 1024;
export const MODEL_TOOL_CALL_LIMIT = 8;
/** SSE deltas repeat metadata and the final response, so wire bytes have a separate cap. */
export const MODEL_STREAM_CAP = 4 * 1024 * 1024;
export const WORKER_TIMEOUT_MS = 120_000;
/** Dedicated Docker builders keep each run's build cache separate from the host's. */
export const BUILDKIT_IMAGE =
  "docker.io/moby/buildkit:buildx-stable-1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea";
/** Longest budget deadline a run or campaign accepts: 24 hours. */
export const MAX_BUDGET_TIMEOUT_MS = 86_400_000;
/**
 * Build deadline of the bundled llmfy and Vercel recipes. Run images share no build
 * cache, so every build pulls its base image and installs every pinned package.
 */
export const RUNTIME_BUILD_TIMEOUT_MS = 600_000;
/** Observations a single live trial may record. */
export const RUN_EVENT_LIMIT = 128;
/** Observations an exported trial may carry (stored evidence is validated more leniently). */
export const EVIDENCE_EVENT_LIMIT = 256;
/** Evaluable trials per case before two campaigns may be compared. */
export const COMPARISON_MIN_EVALUABLE = 20;
export const REPETITION_RANGE = { min: 1, max: 100 } as const;

export const RUN_STATES = ["preparing", "running", "completed", "stopped", "failed"] as const;
export type RunState = (typeof RUN_STATES)[number];
export const OUTCOMES = ["violation_observed", "not_observed", "inconclusive"] as const;
export type RunOutcome = (typeof OUTCOMES)[number];
export const PROFILES = ["llmfy-file-canary-v1", "vercel-booking-sqlite-v1"] as const;
export type ProfileId = (typeof PROFILES)[number];
export const CASE_IDS = [
  "direct-override",
  "claimed-authorization",
  "obscured-path",
  "embedded-instruction",
  "manager-price-override",
  "zero-payment",
] as const;
export type CaseId = (typeof CASE_IDS)[number];
export const CONTROL_TRIAL_ID = "clean-control";
export const TRIAL_IDS = [CONTROL_TRIAL_ID, ...CASE_IDS] as const;
export type TrialId = (typeof TRIAL_IDS)[number];
/** The probe cases each runtime profile can deliver and observe. */
export const PROFILE_CASES: Record<ProfileId, readonly CaseId[]> = {
  "llmfy-file-canary-v1": [
    "direct-override",
    "claimed-authorization",
    "obscured-path",
    "embedded-instruction",
  ],
  "vercel-booking-sqlite-v1": ["manager-price-override", "zero-payment"],
};
/** The most cases one campaign plan can select; the plan schema derives its bound from it. */
export const MAX_PROFILE_CASES = Math.max(
  ...Object.values(PROFILE_CASES).map((cases) => cases.length),
);

/**
 * Version of the stdio frames in docs/design/worker-protocol.md. The host sends it in
 * the request and requires it back in `ready`; the workers in runtimes/ hold the
 * same number. Bump all three together whenever a frame changes.
 */
export const WORKER_PROTOCOL_VERSION = 2;
export const LLMFY_RUNTIME = { python: "3.12.13", llmfy: "0.11.0" } as const;
export const VERCEL_RUNTIME = { node: "22.23.4", ai: "7.0.29" } as const;
export const DATABASE_OBSERVER = "committed-snapshots-v1";
/** Packages the managed Vercel profile supplies; a project must declare matching versions. */
export const VERCEL_PACKAGES: Record<string, string> = {
  ai: VERCEL_RUNTIME.ai,
  zod: "4.4.3",
  "better-sqlite3": "12.11.1",
};

const COMMON_ISOLATION_CHECKS = [
  "non-root",
  "no-capabilities",
  "no-new-privileges",
  "seccomp-filter",
  "loopback-only",
  "read-only-root",
] as const;
const RESOURCE_ISOLATION_CHECKS = [
  "memory-limit",
  "no-swap",
  "process-limit",
  "cpu-limit",
  "no-host-file",
  "no-host-environment",
  "no-container-socket",
] as const;
/** Every check a `ready` frame from the llmfy worker must report. */
export const LLMFY_ISOLATION_CHECKS: readonly string[] = [
  "linux",
  "python-version",
  ...COMMON_ISOLATION_CHECKS,
  "private-temporary-files",
  ...RESOURCE_ISOLATION_CHECKS,
  "image-write-denied",
  "temporary-write",
];
/**
 * The longest a disposable runtime can legitimately exist. A dedicated Docker builder
 * lives for one build; a run image lives for its build plus the longest run deadline.
 * Older labelled images and builders were left by a host that died, and preparing the
 * next runtime removes them.
 */
export const DISPOSABLE_RUNTIME_TTL = {
  builderMs: RUNTIME_BUILD_TIMEOUT_MS + 600_000,
  imageMs: RUNTIME_BUILD_TIMEOUT_MS + MAX_BUDGET_TIMEOUT_MS + 600_000,
} as const;

/** Every check a `ready` frame from the Vercel worker must report. */
export const VERCEL_ISOLATION_CHECKS: readonly string[] = [
  "linux",
  "node-version",
  ...COMMON_ISOLATION_CHECKS,
  ...RESOURCE_ISOLATION_CHECKS,
  "private-temporary-files",
];
export const MODEL_PRICING_LIMITS = { models: 100, perMillion: 1_000_000 } as const;
/**
 * Full Models.dev records retain Claude's separate cache lifetimes, unlike api.json. A
 * provider's record names its base model, whose record holds the input window.
 */
export const MODELS_DEV_PRICING = {
  source: "models.dev",
  baseUrl: "https://raw.githubusercontent.com/anomalyco/models.dev/dev/providers/",
  modelsUrl: "https://raw.githubusercontent.com/anomalyco/models.dev/dev/models/",
  timeoutMs: 15_000,
  bytes: 128 * 1024,
  cacheMs: 24 * 60 * 60 * 1000,
  retryMs: 5 * 60 * 1000,
} as const;

/** Weaknesses a proof test can observe; see docs/design/proof-tests.md. */
export const PROOF_WEAKNESSES = ["CWE-22", "CWE-78"] as const;
export type ProofWeakness = (typeof PROOF_WEAKNESSES)[number];
export const PROOF_OUTCOMES = ["proven", "not-reproduced", "could-not-run"] as const;
export type ProofOutcome = (typeof PROOF_OUTCOMES)[number];
/** The proof images reuse the pinned bases of the llmfy and Vercel images. */
export const PROOF_RUNTIME = { python: LLMFY_RUNTIME.python, node: VERCEL_RUNTIME.node } as const;
/** Every check a proof worker's `ready` frame must report: the same as its base runtime's. */
export const PROOF_ISOLATION_CHECKS = {
  "proof-python": LLMFY_ISOLATION_CHECKS,
  "proof-node": VERCEL_ISOLATION_CHECKS,
} as const;
export const PROOF_LIMITS = {
  /** The test file the model writes. */
  testBytes: 16 * 1024,
  /** Output and error text kept per case. */
  outputBytes: 8 * 1024,
  errorBytes: 2 * 1024,
  /** Effects a case may report, and the length of an effect's path or command. */
  effects: 32,
  targetCharacters: 512,
  /** Entry and cited ranges per run, and the lines a case may report as reached. */
  ranges: 8,
  reachedLines: 4000,
  /** Transport deadline of one run (both cases), and of one case inside the container. */
  runTimeoutMs: 60_000,
  caseTimeoutMs: 20_000,
  /** Combined stdout and stderr the host accepts from a proof worker. */
  workerOutputBytes: 128 * 1024,
} as const;
