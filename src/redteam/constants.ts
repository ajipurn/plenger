/**
 * Single source for the red-team contracts: identifiers, limits and runtime pins.
 * `schema.ts` derives its enums and bounds from these so the JSON schemas cannot drift.
 */

/** Order matters: it is the enum order in the published campaign plan schema. */
export const PROVIDERS = ["openai", "gemini", "ollama"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

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
/** Every check a `ready` frame from the Vercel worker must report. */
export const VERCEL_ISOLATION_CHECKS: readonly string[] = [
  "linux",
  "node-version",
  ...COMMON_ISOLATION_CHECKS,
  ...RESOURCE_ISOLATION_CHECKS,
  "private-temporary-files",
];
