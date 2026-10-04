import type { BudgetLimits } from "../redteam/budget.ts";
import type { CampaignPolicy, CampaignReport } from "../redteam/campaign-model.ts";
import type { ProviderId } from "../redteam/constants.ts";
import type { ProjectPlan } from "../redteam/plan-model.ts";
import type { RedteamRun } from "../redteam/run-model.ts";
import type { Rule } from "../rules/model.ts";
import type { ScanResult } from "../scan.ts";

/** Record shapes persisted by the repositories; the dashboard contract re-exports them. */

export type DashboardTheme = "dark" | "light";

export interface DashboardScan {
  id: string;
  createdAt: string;
  scan: ScanResult;
  rules: Rule[];
}

export interface DashboardScanSummary {
  id: string;
  createdAt: string;
  project: string;
  findings: number;
  files: number;
}

/** The last settings used to start a run or campaign in a project, without any key. */
export interface SavedRunProfile {
  providerId?: string;
  target: string;
  provider: ProviderId;
  model: string;
  limits: BudgetLimits;
  repetitions?: number;
  policy?: CampaignPolicy;
}

/** Everything saved for one project plus the global preferences, as the dashboard shows it. */
export interface WorkspaceSnapshot {
  theme: DashboardTheme;
  project: string;
  report: DashboardScan | null;
  plan: ProjectPlan | null;
  history: DashboardScanSummary[];
  runs: RedteamRun[];
  campaigns: CampaignReport[];
  runProfile: SavedRunProfile | null;
}
