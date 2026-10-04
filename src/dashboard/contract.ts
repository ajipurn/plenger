/**
 * The HTTP contract between the dashboard page and its local service: routes,
 * request and response shapes, the limits both sides enforce, and the theme
 * markup both sides rewrite. The browser bundles this file, so it must stay free
 * of `node:` imports and of anything but types from the engine.
 */
import type { BudgetLimits } from "../redteam/budget.ts";
import type { CampaignPolicy } from "../redteam/campaign.ts";
import { REPETITION_RANGE } from "../redteam/constants.ts";
import type { ProviderAccess } from "../redteam/provider.ts";

// --- Routes -----------------------------------------------------------------------

/** Every endpoint the page calls. `session` is the only one served without a token. */
export const API = {
  session: "/api/session",
  state: "/api/state",
  clear: "/api/state/clear",
  theme: "/api/theme",
  openScan: "/api/history/open",
  folders: "/api/folders",
  chooseFolder: "/api/folders/choose",
  scan: "/api/scan",
  plan: "/api/plan",
  project: "/api/project",
  providers: "/api/providers",
  deleteProvider: "/api/providers/delete",
  testProvider: "/api/providers/test",
  startRun: "/api/redteam/start",
  run: "/api/redteam/run",
  cancel: "/api/redteam/cancel",
  startCampaign: "/api/redteam/campaign/start",
  campaign: "/api/redteam/campaign",
} as const;

/** The header carrying the per-process session token on authenticated requests. */
export const TOKEN_HEADER = "X-Plenger-Token";

// --- Shared models ----------------------------------------------------------------

export type {
  DashboardScan,
  DashboardScanSummary,
  DashboardTheme,
  SavedRunProfile,
} from "../storage/records.ts";

import type { DashboardTheme, WorkspaceSnapshot } from "../storage/records.ts";

/** The response of `GET /api/state`. */
export type DashboardState = WorkspaceSnapshot;

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

// --- Requests and responses -------------------------------------------------------

export interface ErrorResponse {
  error: string;
}

export interface ProjectRequest {
  path: string;
}
export interface PlanRequest extends ProjectRequest {
  target?: string;
}
export interface IdRequest {
  id: string;
}
export interface ThemeRequest {
  theme: DashboardTheme;
}
export interface ThemeResult {
  theme: DashboardTheme;
}
export interface ChooseFolderResult {
  /** `null` when the person cancelled the system dialog. */
  folder: FolderListing | null;
}
export interface DeleteResult {
  deleted: true;
}
export interface CancelResult {
  cancelled: true;
}
export interface ProviderTestResult {
  connected: true;
  model: string;
  durationMs: number;
}

/** Either a saved connection by id, or ad-hoc access whose key is used once and never stored. */
export type ProviderSelection = { providerId: string } | ProviderAccess;

export type StartRunRequest = ProviderSelection & {
  path: string;
  target: string;
  sourceDigest: string;
  limits: BudgetLimits;
};

export type StartCampaignRequest = StartRunRequest & {
  repetitions?: number;
  policy?: CampaignPolicy;
};

// --- Limits -----------------------------------------------------------------------

export interface Range {
  min: number;
  max: number;
}

/** Budget ceilings for one managed run; the form and the service share them. */
export const RUN_LIMITS = {
  maxModelCalls: { min: 1, max: 30 },
  maxTokens: { min: 1, max: 2_000_000 },
  timeoutMs: { min: 1000, max: 600_000 },
} as const satisfies Record<keyof BudgetLimits, Range>;

/** Budget ceilings for a repeated campaign plus its repetition range. */
export const CAMPAIGN_LIMITS = {
  maxModelCalls: { min: 1, max: 1200 },
  maxTokens: { min: 1, max: 50_000_000 },
  timeoutMs: { min: 1000, max: 3_600_000 },
  repetitions: REPETITION_RANGE,
} as const satisfies Record<keyof BudgetLimits | "repetitions", Range>;

// --- Theme ------------------------------------------------------------------------

/** Browser chrome colours matching each theme's page background. */
export const THEME_COLORS: Record<DashboardTheme, string> = {
  dark: "#0b0b0b",
  light: "#fafafa",
};

/**
 * Rewrite the shell's `<html data-theme>`, `color-scheme` and `theme-color` so the
 * saved theme applies before any script runs. The service does this for every HTML
 * response; the Vite dev server does it for its transformed index.
 */
export function applyThemeToHtml(html: string, theme: DashboardTheme): string {
  return html
    .replace(
      /<html\b([^>]*)>/i,
      (_match, attributes: string) =>
        `<html${attributes.replace(/\sdata-theme="[^"]*"/i, "")} data-theme="${theme}">`,
    )
    .replace(/name="color-scheme" content="[^"]*"/, `name="color-scheme" content="${theme}"`)
    .replace(
      /name="theme-color" content="[^"]*"/,
      `name="theme-color" content="${THEME_COLORS[theme]}"`,
    );
}
