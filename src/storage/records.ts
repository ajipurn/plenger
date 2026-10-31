import type { BudgetLimits } from "../redteam/budget.ts";
import type { CampaignPolicy, CampaignReport } from "../redteam/campaign-model.ts";
import type { ProviderId } from "../redteam/constants.ts";
import type { ProjectPlan } from "../redteam/plan-model.ts";
import type { RedteamRun } from "../redteam/run-model.ts";
import type { Rule } from "../rules/model.ts";
import type { ScanResult } from "../scan.ts";

/** Record shapes persisted by the repositories; the dashboard contract re-exports them. */

/** The saved theme. System follows the device's light or dark setting. */
export const DASHBOARD_THEMES = ["dark", "system", "light"] as const;
export type DashboardTheme = (typeof DASHBOARD_THEMES)[number];

export function isDashboardTheme(value: unknown): value is DashboardTheme {
  return DASHBOARD_THEMES.some((theme) => theme === value);
}

/** How tightly rows and panels are spaced. Compact fits more findings on screen. */
export const DASHBOARD_DENSITIES = ["comfortable", "compact"] as const;
export type DashboardDensity = (typeof DASHBOARD_DENSITIES)[number];

export function isDashboardDensity(value: unknown): value is DashboardDensity {
  return DASHBOARD_DENSITIES.some((density) => density === value);
}

/** The saved appearance the service writes into every page before scripts run. */
export interface DashboardAppearance {
  theme: DashboardTheme;
  density: DashboardDensity;
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
  density: DashboardDensity;
  project: string;
  report: DashboardScan | null;
  plan: ProjectPlan | null;
  history: DashboardScanSummary[];
  runs: RedteamRun[];
  campaigns: CampaignReport[];
  runProfile: SavedRunProfile | null;
}
