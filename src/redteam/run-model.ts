import { randomUUID } from "node:crypto";
import type { BudgetLimits, BudgetSnapshot, ModelBudget } from "./budget.ts";
import {
  type CaseId,
  CONTROL_TRIAL_ID,
  PROFILE_CASES,
  type ProfileId,
  type RunOutcome,
  type RunState,
  type TrialId,
} from "./constants.ts";
import type { RunProvider } from "./provider.ts";
import type { ProviderConfig } from "./provider-config.ts";

export type { RunOutcome };

export interface RunEvent {
  sequence: number;
  stage: "model_tool_proposal" | "tool_handler_entered" | "tool_handler_returned" | "canary_state";
  tool?: string;
  boundary?: "allowed" | "forbidden";
  markerPresent?: boolean;
  callId?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
}
export interface RunTrial {
  id: TrialId;
  purpose: "control" | "probe";
  started: boolean;
  completed: boolean;
  outcome: RunOutcome;
  events: RunEvent[];
  modelCalls: number;
  workerName: string | null;
  conversation?: { id: number; role: "user" | "assistant"; content: string }[];
  database?: {
    expectedAmount: number;
    bookingId: string | null;
    before: DatabaseState;
    after?: DatabaseState;
    observations?: {
      sequence: number;
      final: boolean;
      callIds: string[];
      after: DatabaseState;
    }[];
  };
}
export interface DatabaseState {
  bookings: { id: string; service: string; date: string; time: string }[];
  invoices: { bookingId: string; amount: number; status: string }[];
  payments: { bookingId: string; amount: number; status: string }[];
}
export interface RedteamRun {
  schemaVersion: 1;
  kind: "redteam-run";
  id: string;
  root: string;
  target: string;
  sourceDigest: string;
  createdAt: string;
  finishedAt: string | null;
  state: RunState;
  provider: string;
  model: string;
  providerConfig?: ProviderConfig;
  profile: ProfileId;
  evidenceScope: "isolated-file-canary" | "isolated-route-sqlite";
  tokenAccounting: "conservative-byte-bound-with-provider-usage";
  cleanControlPassed: boolean;
  cleanupConfirmed: boolean;
  error: string | null;
  budget: BudgetSnapshot | null;
  trials: RunTrial[];
  backendChecks?: {
    tool: string;
    outcome: RunOutcome;
    arguments: Record<string, unknown>;
    before: DatabaseState;
    after: DatabaseState;
  }[];
  backendWorkerName?: string;
  runtime?:
    | {
        image: string;
        node: string;
        ai: string;
        databaseObserver: "committed-snapshots-v1";
      }
    | { image: string; python: string; llmfy: string };
}
export interface RunOptions {
  target: string;
  sourceDigest: string;
  limits: BudgetLimits;
  provider: RunProvider;
  signal?: AbortSignal;
  onUpdate?: (report: RedteamRun) => void;
  profile?: ProfileId;
  /** Internal campaign ledger: child runs must not close it. */
  sharedBudget?: ModelBudget;
  caseIds?: TrialId[];
}

function emptyTrial(id: TrialId, profile: ProfileId): RunTrial {
  return {
    id,
    purpose: id === CONTROL_TRIAL_ID ? "control" : "probe",
    started: false,
    completed: false,
    outcome: "inconclusive",
    events: [],
    modelCalls: 0,
    workerName: null,
    ...(profile === "vercel-booking-sqlite-v1" ? { conversation: [] } : {}),
  };
}

/** A run report in its `preparing` state: the control plus the profile's selected probes. */
export function newRun(root: string, options: RunOptions): RedteamRun {
  const profile = options.profile ?? "llmfy-file-canary-v1";
  const ids: TrialId[] = [CONTROL_TRIAL_ID, ...(PROFILE_CASES[profile] as CaseId[])];
  const report: RedteamRun = {
    schemaVersion: 1,
    kind: "redteam-run",
    id: randomUUID(),
    root,
    target: options.target,
    sourceDigest: options.sourceDigest,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    state: "preparing",
    provider: options.provider.name,
    model: options.provider.model,
    profile,
    evidenceScope:
      profile === "vercel-booking-sqlite-v1" ? "isolated-route-sqlite" : "isolated-file-canary",
    tokenAccounting: "conservative-byte-bound-with-provider-usage",
    cleanControlPassed: false,
    cleanupConfirmed: true,
    error: null,
    budget: null,
    trials: ids.map((id) => emptyTrial(id, profile)),
  };
  if (options.caseIds)
    report.trials = report.trials.filter(
      (trial) => trial.purpose === "control" || options.caseIds?.includes(trial.id),
    );
  return report;
}
