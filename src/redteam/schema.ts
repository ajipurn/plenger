import { SEVERITIES } from "../rules/model.ts";
import {
  CASE_IDS,
  EVIDENCE_EVENT_LIMIT,
  MAX_OUTPUT_TOKENS,
  MAX_PROFILE_CASES,
  OUTCOMES,
  PROFILES,
  PROVIDERS,
  REPETITION_RANGE,
  RUN_STATES,
  TEMPERATURE_RANGE,
  TRIAL_IDS,
} from "./constants.ts";

/** Independent dynamic evidence contracts. Static report-v1 remains unchanged. */
type Schema = Record<string, unknown>;
const text: Schema = { type: "string" };
const boolean: Schema = { type: "boolean" };
const natural: Schema = { type: "integer", minimum: 0 };
const positive: Schema = { type: "integer", minimum: 1 };
const ratio: Schema = { type: "number", minimum: 0, maximum: 1 };
const digest: Schema = { type: "string", pattern: "^[a-f0-9]{64}$" };
const date: Schema = { type: "string", format: "date-time" };
const state = choices(...RUN_STATES);
const outcome = choices(...OUTCOMES);
const profile = choices(...PROFILES);
const caseId = choices(...CASE_IDS);
const repetitions: Schema = {
  type: "integer",
  minimum: REPETITION_RANGE.min,
  maximum: REPETITION_RANGE.max,
};
function choices(...values: readonly string[]): Schema {
  return { type: "string", enum: values };
}
function nullable(schema: Schema): Schema {
  return { anyOf: [schema, { type: "null" }] };
}
function array(items: Schema, maximum?: number): Schema {
  return { type: "array", items, ...(maximum === undefined ? {} : { maxItems: maximum }) };
}
function ref(name: string): Schema {
  return { $ref: `#/definitions/${name}` };
}
function object(required: Record<string, Schema>, optional: Record<string, Schema> = {}): Schema {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(required),
    properties: { ...required, ...optional },
  };
}
const argumentsObject: Schema = { type: "object" };
const location = object({
  path: text,
  line: positive,
  column: positive,
  endLine: positive,
  endColumn: positive,
});
const limits = object({ maxModelCalls: positive, maxTokens: positive, timeoutMs: positive });
const usage = object({ inputTokens: natural, outputTokens: natural, additionalTokens: natural });
const providerConfig = object({
  id: text,
  name: text,
  baseUrl: { type: "string", format: "uri" },
  temperature: nullable({
    type: "number",
    minimum: TEMPERATURE_RANGE.min,
    maximum: TEMPERATURE_RANGE.max,
  }),
  maxOutputTokens: nullable({ type: "integer", minimum: 1, maximum: MAX_OUTPUT_TOKENS }),
});
const databaseState = object({
  bookings: array(object({ id: text, service: text, date: text, time: text }), 20),
  invoices: array(object({ bookingId: text, amount: { type: "integer" }, status: text }), 20),
  payments: array(object({ bookingId: text, amount: { type: "integer" }, status: text }), 20),
});
const definitions: Record<string, Schema> = {
  limits,
  budget: object(
    {
      schemaVersion: { const: 1 },
      kind: { const: "redteam-model-budget" },
      enforcementScope: { const: "submitted-dispatches" },
      state: choices("open", "completed", "stopped"),
      limits: ref("limits"),
      stopReasons: array(
        choices(
          "model-call-limit",
          "token-limit",
          "deadline",
          "cancelled",
          "invalid-provider-response",
          "invalid-provider-usage",
          "provider-usage-exceeded-reservation",
        ),
      ),
      callsAdmitted: natural,
      callsInFlight: natural,
      providersUnsettled: natural,
      observedTokens: natural,
      outstandingReservedTokens: natural,
      accountedTokens: natural,
      remainingCalls: natural,
      remainingTokens: natural,
      calls: array(
        object({
          id: positive,
          purpose: choices("setup", "control", "probe", "retry"),
          state: choices("in-flight", "succeeded", "failed", "interrupted"),
          providerSettled: boolean,
          reservation: usage,
          usage: nullable(usage),
          accounting: choices("reserved", "confirmed", "unknown", "overrun"),
          accountedTokens: natural,
        }),
        1200,
      ),
    },
    { tokenLimitMode: { const: "observed" } },
  ),
  securityCase: object({
    id: caseId,
    version: { const: 1 },
    title: text,
    severity: choices(...SEVERITIES),
    rationale: { type: "string", minLength: 1 },
    oracle: choices("completed-file-write", "committed-invoice-change", "committed-underpayment"),
  }),
  scope: object(
    {
      id: { type: "string", pattern: "^scope:[a-f0-9]{24}$" },
      target: text,
      caseId: text,
      supported: boolean,
      selected: boolean,
      reason: nullable(text),
    },
    { kind: choices("input", "tool", "mcp", "web", "retrieval"), label: text, location },
  ),
  policy: object({
    failOn: choices(...SEVERITIES, "none"),
    minCoverage: { type: "number", exclusiveMinimum: 0, maximum: 1 },
    minimumEvaluable: repetitions,
    suppressions: array(
      object({ caseId, reason: { type: "string", minLength: 1, maxLength: 1000 } }),
      2,
    ),
  }),
  plan: object(
    {
      schemaVersion: { const: 1 },
      kind: { const: "redteam-campaign-plan" },
      root: text,
      target: text,
      sourceDigest: digest,
      profile,
      provider: choices(...PROVIDERS),
      model: text,
      repetitions,
      limits: ref("limits"),
      cases: { ...array(ref("securityCase"), MAX_PROFILE_CASES), minItems: 1 },
      scope: array(ref("scope"), 10000),
      requiredScope: {
        ...array({ type: "string", pattern: "^scope:[a-f0-9]{24}$" }, 10000),
        uniqueItems: true,
      },
      policy: ref("policy"),
      build: nullable(text),
    },
    { providerConfig, scopeIncomplete: boolean },
  ),
  trial: object(
    {
      id: choices(...TRIAL_IDS),
      purpose: choices("control", "probe"),
      started: boolean,
      completed: boolean,
      outcome,
      events: array(
        object(
          {
            sequence: positive,
            stage: choices(
              "model_tool_proposal",
              "tool_handler_entered",
              "tool_handler_returned",
              "canary_state",
            ),
          },
          {
            tool: text,
            boundary: choices("allowed", "forbidden"),
            markerPresent: boolean,
            callId: text,
            arguments: argumentsObject,
            result: {},
          },
        ),
        EVIDENCE_EVENT_LIMIT,
      ),
      modelCalls: natural,
      workerName: nullable(text),
    },
    {
      conversation: array(
        object({ id: natural, role: choices("user", "assistant"), content: text }),
      ),
      database: object(
        { expectedAmount: positive, bookingId: nullable(text), before: databaseState },
        {
          after: databaseState,
          observations: array(
            object({
              sequence: positive,
              final: boolean,
              callIds: array(text),
              after: databaseState,
            }),
            64,
          ),
        },
      ),
    },
  ),
  run: object(
    {
      schemaVersion: { const: 1 },
      kind: { const: "redteam-run" },
      id: text,
      root: text,
      target: text,
      sourceDigest: digest,
      createdAt: date,
      finishedAt: nullable(date),
      state,
      provider: text,
      model: text,
      profile,
      evidenceScope: choices("isolated-file-canary", "isolated-route-sqlite"),
      tokenAccounting: { const: "conservative-byte-bound-with-provider-usage" },
      cleanControlPassed: boolean,
      cleanupConfirmed: boolean,
      error: nullable(text),
      budget: nullable(ref("budget")),
      trials: array(ref("trial"), 3),
    },
    {
      providerConfig,
      backendChecks: array(
        object({
          tool: text,
          outcome,
          arguments: argumentsObject,
          before: databaseState,
          after: databaseState,
        }),
        2,
      ),
      backendWorkerName: text,
      runtime: {
        oneOf: [
          object({ image: text, python: text, llmfy: text }),
          object({
            image: text,
            node: text,
            ai: text,
            databaseObserver: { const: "committed-snapshots-v1" },
          }),
        ],
      },
    },
  ),
  statistics: object({
    caseId,
    planned: positive,
    counts: object({
      violation_observed: natural,
      not_observed: natural,
      inconclusive: natural,
      error: natural,
      skipped: natural,
    }),
    evaluable: natural,
    coverage: ratio,
    rate: nullable(ratio),
    interval: nullable(
      object({ method: { const: "wilson" }, confidence: { const: 0.95 }, low: ratio, high: ratio }),
    ),
    comparisonEligible: boolean,
  }),
  gate: object({
    exitCode: { type: "integer", enum: [0, 1, 3] },
    reasons: array(
      object({ kind: choices("finding", "execution", "coverage", "scope"), message: text }),
    ),
  }),
  campaign: object({
    schemaVersion: { const: 1 },
    kind: { const: "redteam-campaign" },
    id: text,
    plan: ref("plan"),
    createdAt: date,
    finishedAt: nullable(date),
    state,
    runs: array(ref("run"), REPETITION_RANGE.max),
    budget: nullable(ref("budget")),
    statistics: array(ref("statistics"), 2),
    gate: ref("gate"),
  }),
  taskCompletion: object({
    planned: positive,
    passed: natural,
    failed: natural,
    missing: natural,
    rate: ratio,
  }),
  comparison: object({
    schemaVersion: { const: 1 },
    kind: { const: "redteam-comparison" },
    before: object({ id: text, sourceDigest: digest, build: nullable(text) }),
    after: object({ id: text, sourceDigest: digest, build: nullable(text) }),
    change: text,
    compatible: boolean,
    eligible: boolean,
    reasons: array(text),
    changes: array(text),
    assumptions: array(text),
    cases: array(
      object({
        caseId,
        before: nullable(ref("statistics")),
        after: nullable(ref("statistics")),
        eligible: boolean,
        rateChange: nullable({ type: "number", minimum: -1, maximum: 1 }),
      }),
      CASE_IDS.length,
    ),
    taskCompletion: object({
      before: ref("taskCompletion"),
      after: ref("taskCompletion"),
      change: nullable({ type: "number", minimum: -1, maximum: 1 }),
    }),
    afterGate: ref("gate"),
  }),
};
function document(title: string, definition: string): Schema {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title,
    ...ref(definition),
    definitions,
  };
}
export const REDTEAM_SCHEMAS = {
  "redteam-run-v1.schema.json": document("Plenger dynamic run v1", "run"),
  "redteam-campaign-plan-v1.schema.json": document("Plenger campaign plan v1", "plan"),
  "redteam-campaign-v1.schema.json": document("Plenger campaign evidence v1", "campaign"),
  "redteam-comparison-v1.schema.json": document("Plenger campaign comparison v1", "comparison"),
};
