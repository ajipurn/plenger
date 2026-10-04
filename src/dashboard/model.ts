import type { BudgetLimits } from "../redteam/budget.ts";
import type { ProjectPlan } from "../redteam/plan.ts";
import type { ProviderAccess } from "../redteam/provider.ts";
import type { RedteamRun } from "../redteam/run.ts";
import type { Rule } from "../rules/model.ts";
import type { ScanResult } from "../scan.ts";

export type DashboardTheme = "dark" | "light";

export interface DashboardSession {
  workspace: string;
  token: string;
  theme: DashboardTheme;
}

export interface FolderListing {
  path: string;
  parent: string | null;
  folders: { name: string; path: string }[];
}

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

export interface DashboardState {
  theme: DashboardTheme;
  project: string;
  report: DashboardScan | null;
  plan: ProjectPlan | null;
  history: DashboardScanSummary[];
  runs: RedteamRun[];
  runProfile: SavedRunProfile | null;
}

export interface SavedRunProfile {
  target: string;
  provider: ProviderAccess["provider"];
  model: string;
  limits: BudgetLimits;
}
