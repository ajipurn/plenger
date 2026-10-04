import { createContext, type ReactNode, useContext, useMemo, useReducer } from "react";
import type {
  DashboardScan,
  DashboardScanSummary,
  DashboardState,
  SavedRunProfile,
} from "../../../src/dashboard/contract.ts";
import type { CampaignReport } from "../../../src/redteam/campaign.ts";
import type { ProjectPlan } from "../../../src/redteam/plan.ts";
import type { SavedProvider } from "../../../src/redteam/provider-config.ts";
import type { RedteamRun } from "../../../src/redteam/run.ts";
import type { DashboardApi } from "../api/client.ts";
import { upsertRecent } from "../shared/runs.ts";

export type Busy = "scan" | "plan" | "project" | "history" | "clear";

export interface WorkspaceState {
  project: string;
  report: DashboardScan | null;
  history: DashboardScanSummary[];
  plan: ProjectPlan | null;
  runs: RedteamRun[];
  campaigns: CampaignReport[];
  runProfile: SavedRunProfile | null;
  providers: SavedProvider[];
  busy: Busy | null;
  error: string;
  planError: string | null;
}

type WorkspaceAction =
  | { type: "restore"; state: DashboardState }
  | { type: "scan-complete"; result: DashboardScan }
  | { type: "plan"; plan: ProjectPlan }
  | { type: "run"; run: RedteamRun }
  | { type: "campaign"; campaign: CampaignReport }
  | { type: "providers"; providers: SavedProvider[] }
  | { type: "busy"; busy: Busy | null }
  | { type: "error"; error: string }
  | { type: "plan-error"; error: string | null };

const RECENT_LIMIT = 20;

const initialState: WorkspaceState = {
  project: "",
  report: null,
  history: [],
  plan: null,
  runs: [],
  campaigns: [],
  runProfile: null,
  providers: [],
  busy: null,
  error: "",
  planError: null,
};

function reduce(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "restore":
      return {
        ...state,
        project: action.state.project,
        report: action.state.report,
        plan: action.state.plan,
        runs: action.state.runs,
        campaigns: action.state.campaigns,
        runProfile: action.state.runProfile,
        history: action.state.history,
        error: "",
        planError: null,
      };
    case "scan-complete": {
      const { result } = action;
      return {
        ...state,
        report: result,
        project: result.scan.root,
        plan: null,
        planError: null,
        history: [
          {
            id: result.id,
            createdAt: result.createdAt,
            project: result.scan.root,
            findings: result.scan.findings.length,
            files: result.scan.files.length,
          },
          ...state.history,
        ],
      };
    }
    case "plan":
      return { ...state, plan: action.plan };
    case "run":
      return { ...state, runs: upsertRecent(state.runs, action.run, RECENT_LIMIT) };
    case "campaign": {
      const { campaign } = action;
      return {
        ...state,
        campaigns: upsertRecent(state.campaigns, campaign, RECENT_LIMIT),
        runProfile: {
          target: campaign.plan.target,
          provider: campaign.plan.provider,
          model: campaign.plan.model,
          limits: campaign.plan.limits,
          repetitions: campaign.plan.repetitions,
          policy: campaign.plan.policy,
          ...(campaign.plan.providerConfig ? { providerId: campaign.plan.providerConfig.id } : {}),
        },
      };
    }
    case "providers":
      return { ...state, providers: action.providers };
    case "busy":
      return { ...state, busy: action.busy };
    case "error":
      return { ...state, error: action.error };
    case "plan-error":
      return { ...state, planError: action.error };
  }
}

/** Workspace data restored from the local service and updated by user actions. */
export function useDashboardState() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const actions = useMemo(
    () => ({
      restore: (next: DashboardState) => dispatch({ type: "restore", state: next }),
      scanComplete: (result: DashboardScan) => dispatch({ type: "scan-complete", result }),
      setPlan: (plan: ProjectPlan) => dispatch({ type: "plan", plan }),
      updateRun: (run: RedteamRun) => dispatch({ type: "run", run }),
      updateCampaign: (campaign: CampaignReport) => dispatch({ type: "campaign", campaign }),
      setProviders: (providers: SavedProvider[]) => dispatch({ type: "providers", providers }),
      setBusy: (busy: Busy | null) => dispatch({ type: "busy", busy }),
      setError: (error: string) => dispatch({ type: "error", error }),
      setPlanError: (error: string | null) => dispatch({ type: "plan-error", error }),
    }),
    [],
  );
  return { state, actions };
}

export type DashboardActions = ReturnType<typeof useDashboardState>["actions"];

const ApiContext = createContext<DashboardApi | null | undefined>(undefined);

export function DashboardProvider({
  api,
  children,
}: {
  api: DashboardApi | null;
  children: ReactNode;
}) {
  return <ApiContext value={api}>{children}</ApiContext>;
}

/** The connected client, or null until the local service has answered. */
export function useApi(): DashboardApi | null {
  const api = useContext(ApiContext);
  if (api === undefined) throw new Error("useApi requires a DashboardProvider.");
  return api;
}
