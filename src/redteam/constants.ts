/**
 * Single source for the red-team contracts: identifiers, limits and runtime pins.
 * `schema.ts` derives its enums and bounds from these so the JSON schemas cannot drift.
 */

/** Order matters: it is the enum order in the published campaign plan schema. */
export const PROVIDERS = ["openai", "gemini", "ollama", "chatgpt"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

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

/** An immutable image ID, optionally prefixed for the Docker engine. */
export const IMAGE_ID = /^(?:docker:)?sha256:[a-f0-9]{64}$/;
/** Captured source bytes a managed runtime accepts per run. */
export const SOURCE_BYTE_CAP = 4 * 1024 * 1024;
/** Serialised model request/response sizes the bounded transport accepts. */
export const MODEL_REQUEST_CAP = 48 * 1024;
export const MODEL_RESPONSE_CAP = 64 * 1024;
/** SSE deltas repeat metadata and the final response, so wire bytes have a separate cap. */
export const MODEL_STREAM_CAP = 4 * 1024 * 1024;
export const WORKER_TIMEOUT_MS = 120_000;
/** Observations a single live trial may record. */
export const RUN_EVENT_LIMIT = 128;
/** Observations an exported trial may carry (stored evidence is validated more leniently). */
export const EVIDENCE_EVENT_LIMIT = 256;
/** Evaluable trials per case before two campaigns may be compared. */
export const COMPARISON_MIN_EVALUABLE = 20;
export const REPETITION_RANGE = { min: 1, max: 100 } as const;
/** `plenger redteam run` defaults; the timeout is given in seconds on the command line. */
export const CLI_DEFAULT_LIMITS = { calls: 12, tokens: 200_000, timeoutSeconds: 600 } as const;

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
export const WORKER_PROTOCOL_VERSION = 1;
export const LLMFY_RUNTIME = { python: "3.12.13", llmfy: "0.11.0" } as const;
export const VERCEL_RUNTIME = { node: "22.18.0", ai: "7.0.29" } as const;
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
 * The FastAPI project profile (M6b, docs/design/fastapi-profile.md). Preparation only:
 * it builds the project's dependencies, imports the application beside disposable
 * services and probes one route. It joins `PROFILES` when its first case pack runs.
 */
export const FASTAPI_PROFILE = "fastapi-llmfy-v1" as const;
export const FASTAPI_RUNTIME = { python: "3.12.13" } as const;
/** llmfy versions with a broker adapter under runtimes/fastapi/adapters/. */
export const FASTAPI_LLMFY_ADAPTERS: readonly string[] = ["0.6.0"];
/** Disposable services started beside a FastAPI worker; multi-arch index digests as of 2026-10-06. */
export const FASTAPI_SERVICES = {
  mysql: {
    image:
      "docker.io/library/mysql:8.4@sha256:6ea90827b1100f8f2ae306a539f86d2c264a26ed435a2a9f75551dd5c3aeb242",
    port: 3306,
  },
  redis: {
    image:
      "docker.io/library/redis:7.4-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499",
    port: 6379,
  },
} as const;
export type FastapiService = keyof typeof FASTAPI_SERVICES;
/**
 * Text resources the FastAPI profile captures beside Python sources when they sit under
 * a captured Python package: prompts, templates and small data files read at import.
 * The worker accepts exactly these suffixes (`SOURCE_SUFFIXES` in runtimes/fastapi/worker.py).
 */
export const FASTAPI_RESOURCE_EXTENSIONS: readonly string[] = [
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".jinja",
  ".j2",
  ".html",
  ".csv",
  ".sql",
];
/**
 * Credentials SDK clients demand at construction. The worker has no route to any
 * provider and every llmfy model class is replaced, so these values can never be used;
 * they only let an application import. Project-specific settings come from the user.
 */
export const FASTAPI_PLACEHOLDER_SETTINGS: Readonly<Record<string, string>> = {
  AWS_ACCESS_KEY_ID: "plenger-placeholder",
  AWS_SECRET_ACCESS_KEY: "plenger-placeholder",
  AWS_DEFAULT_REGION: "us-east-1",
  AWS_REGION: "us-east-1",
  /** llmfy's own name for the Bedrock region; its model class is replaced, the setting still must exist. */
  AWS_BEDROCK_REGION: "us-east-1",
  OPENAI_API_KEY: "plenger-placeholder",
  GOOGLE_API_KEY: "plenger-placeholder",
  GEMINI_API_KEY: "plenger-placeholder",
  ANTHROPIC_API_KEY: "plenger-placeholder",
};
/** Limits of a FastAPI worker; its preflight checks these exact values. */
export const FASTAPI_WORKER = {
  memoryBytes: 1024 * 1024 * 1024,
  pids: 128,
  tmpfsMiB: 64,
  /** Transport deadline: a full application import under emulation is slow. */
  timeoutMs: 300_000,
  /** Resolving and installing a project's wheels, including a possible platform retry. */
  buildTimeoutMs: 1_800_000,
} as const;
/** Every check a `ready` frame from the FastAPI worker must report. */
export const FASTAPI_ISOLATION_CHECKS: readonly string[] = [
  "linux",
  "python-version",
  "non-root",
  "no-capabilities",
  "no-new-privileges",
  "seccomp-filter",
  "private-network-only",
  "no-default-route",
  "read-only-root",
  "private-temporary-files",
  ...RESOURCE_ISOLATION_CHECKS,
  "image-write-denied",
  "temporary-write",
];

/** Every check a `ready` frame from the Vercel worker must report. */
export const VERCEL_ISOLATION_CHECKS: readonly string[] = [
  "linux",
  "node-version",
  ...COMMON_ISOLATION_CHECKS,
  ...RESOURCE_ISOLATION_CHECKS,
  "private-temporary-files",
];
