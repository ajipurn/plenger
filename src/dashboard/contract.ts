/**
 * The HTTP contract between the dashboard page and its local service: routes,
 * request and response shapes, the limits both sides enforce, and the theme
 * markup both sides rewrite. The browser bundles this file, so it must stay free
 * of `node:` imports and take engine values only from modules that have none.
 */
import type { BudgetLimits } from "../redteam/budget.ts";
import type { CampaignPolicy } from "../redteam/campaign.ts";
import { REPETITION_RANGE } from "../redteam/constants.ts";
import type { ModelPricing } from "../redteam/model-pricing.ts";
import type { ProviderAccess } from "../redteam/provider.ts";
import type { ProviderModel } from "../redteam/provider-models.ts";

export type { ProviderModel } from "../redteam/provider-models.ts";

import type { FixPromptDraft } from "../remediation/fix-prompt.ts";
import type { ScanReply } from "../security/model.ts";

export type {
  DismissalBasis,
  ExploreSessionRecord,
  ReviewFinding,
  ReviewMode,
  ReviewPath,
  SecurityReview,
  StaticReviewFinding,
} from "../assessment/review-model.ts";
export {
  batchCostBound,
  batchTokenBound,
  EXPLORE_LIMITS,
  EXPLORE_STOPS,
  exploreCostBound,
  exploreTokenBound,
  reviewBudget,
  SECURITY_REVIEW_LIMITS,
} from "../assessment/review-model.ts";
export type { ImportedReaEvidence } from "../evidence/rea-model.ts";
export { REA_LIMITS } from "../evidence/rea-model.ts";
export type {
  FindingStatus,
  LocalRepository,
  ProjectThreatModel,
  ScanActivity,
  ScanAiOptions,
  ScanBudget,
  ScanCoverage,
  ScanDepth,
  ScanReply,
  SecurityFinding,
  SecurityScan,
  SecurityScanSummary,
  SecurityWorkspace,
  SelectableScanDepth,
  StartSecurityScan,
} from "../security/model.ts";
export {
  canContinue,
  FINDING_STATUSES,
  findingOrigins,
  findingValidation,
  remainingBudget,
  SCAN_BUDGET_LIMITS,
  SCAN_DEPTHS,
  SECURITY_POLL_MS,
  THREAT_MODEL_LIMITS,
} from "../security/model.ts";

// --- Routes -----------------------------------------------------------------------

/** Every endpoint the page calls. `session` is the only one served without a token. */
export const API = {
  session: "/api/session",
  state: "/api/state",
  clear: "/api/state/clear",
  theme: "/api/theme",
  density: "/api/density",
  openScan: "/api/history/open",
  folders: "/api/folders",
  chooseFolder: "/api/folders/choose",
  scan: "/api/scan",
  generateFixPrompt: "/api/findings/fix-prompt",
  securityReviews: "/api/security/reviews",
  securityWorkspace: "/api/security/workspace",
  repositories: "/api/security/repositories",
  updateRepository: "/api/security/repositories/:id",
  repositorySource: "/api/security/repositories/:id/source",
  deleteRepository: "/api/security/repositories/:id/delete",
  securityScans: "/api/security/scans",
  securityScan: "/api/security/scans/:id",
  scanSourceFiles: "/api/security/scans/:id/source-files",
  securityEvents: "/api/security/events",
  cancelSecurityScan: "/api/security/scans/:id/cancel",
  pauseSecurityScan: "/api/security/scans/:id/pause",
  continueSecurityScan: "/api/security/scans/:id/continue",
  findingStatus: "/api/security/findings/:id/status",
  reaEvidence: "/api/evidence/rea",
  deleteReaEvidence: "/api/evidence/rea/delete",
  plan: "/api/plan",
  project: "/api/project",
  providers: "/api/providers",
  deleteProvider: "/api/providers/delete",
  testProvider: "/api/providers/test",
  providerModels: "/api/providers/models",
  modelPricing: "/api/providers/pricing",
  modelWindow: "/api/providers/window",
  chatgptLogin: "/api/providers/chatgpt/login",
  chatgptLoginStatus: "/api/providers/chatgpt/login/status",
  cancelChatgptLogin: "/api/providers/chatgpt/login/cancel",
  startRun: "/api/redteam/start",
  run: "/api/redteam/run",
  cancel: "/api/redteam/cancel",
  startCampaign: "/api/redteam/campaign/start",
  campaign: "/api/redteam/campaign",
} as const;

/** The header carrying the per-process session token on authenticated requests. */
export const TOKEN_HEADER = "X-Plenger-Token";
/** Provider settings can include a bounded price table for up to 100 models. */
export const PROVIDER_SETTINGS_BYTES = 128 * 1024;
/** Short selects retain their compact list; larger lists include a search field. */
export const SELECT_SEARCH_MIN_OPTIONS = 10;

// --- Shared models ----------------------------------------------------------------

export type {
  DashboardAppearance,
  DashboardDensity,
  DashboardScan,
  DashboardScanSummary,
  DashboardTheme,
  SavedRunProfile,
} from "../storage/records.ts";
export {
  DASHBOARD_DENSITIES,
  DASHBOARD_THEMES,
  isDashboardDensity,
  isDashboardTheme,
} from "../storage/records.ts";

import type {
  DashboardAppearance,
  DashboardDensity,
  DashboardTheme,
  WorkspaceSnapshot,
} from "../storage/records.ts";

/** The response of `GET /api/state`. */
export type DashboardState = WorkspaceSnapshot;

export interface DashboardSession {
  workspace: string;
  token: string;
  theme: DashboardTheme;
  density: DashboardDensity;
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
export interface ThemeResult {
  theme: DashboardTheme;
}
export interface DensityResult {
  density: DashboardDensity;
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
export interface PauseResult {
  paused: true;
}
export interface ProviderTestResult {
  connected: true;
  model: string;
  durationMs: number;
}

export interface ProviderModelsRequest {
  id?: string;
  provider: "openai" | "anthropic";
  baseUrl: string;
  apiKey?: string;
  /** Explicitly replace a saved catalog with the provider's latest list. */
  refresh?: boolean;
}
export interface ProviderModelsResult {
  models: ProviderModel[];
}
export interface ModelPricingRequest {
  provider?: "anthropic" | "openai";
  model: string;
  refresh?: boolean;
}
export interface ModelPricingResult {
  pricing: ModelPricing;
  /** A failed automatic update fell back to the last successful local record. */
  stale: boolean;
}
/** A saved connection's model, whose input window sizes a scan's rounds. */
export interface ModelWindowRequest {
  id: string;
  model: string;
}
export interface ModelWindowResult {
  /** The window a scan with this model uses; null keeps the default round size. */
  inputTokens: number | null;
}

export interface FixPromptRequest {
  scanId: string;
  fingerprint: string;
  providerId: string;
  reaEvidenceId?: string;
  reviewId?: string;
}

export const WORKSPACE_LIMITS = {
  pathCharacters: 4096,
  nameCharacters: 160,
  environmentCharacters: 120,
  contextCharacters: 2000,
  recordIdCharacters: 128,
  pageSize: 30,
} as const;

export interface AddRepositoryRequest {
  path: string;
  name?: string;
  environment?: string;
  notes?: string;
}

/** What a review of a project could read, listed without reading file contents. */
export interface RepositorySource {
  files: number;
  bytes: number;
  /** Listing stopped at the scan's file limit; the project holds more. */
  truncated: boolean;
}

/**
 * What `API.securityEvents` streams as server-sent events: a scan was saved, so its
 * record and the workspace changed, or a running scan's reply progressed.
 */
export type SecurityEvent =
  | { type: "scan"; id: string }
  | { type: "reply"; id: string; reply: ScanReply | null };

/** The files a scan's reviews could read, listed from its saved static scan. */
export interface ScanSourceFiles {
  /** Null when the scan has no saved static scan to list them from. */
  paths: string[] | null;
}

export interface UpdateRepositoryRequest {
  environment?: string;
  notes?: string;
  pauseMonitoring?: true;
  /** A threat model the user wrote, which reviews then keep; null lets the next scan derive one. */
  threatModel?: { architecture: string; assets: string[]; trustBoundaries: string[] } | null;
}

export interface ReaImportRequest {
  scanId: string;
  filename: string;
  evidence: unknown;
}

export type FixPromptResult = FixPromptDraft & {
  scanId: string;
  fingerprint: string;
  provider: { id: string; name: string; model: string };
  createdAt: string;
  reaEvidenceId?: string;
  reviewId?: string;
};

export const CHATGPT_LOGIN_POLL_MS = 1000;
/** Connection settings; `anotherAccount` signs in under a new registration. */
export type ChatgptLoginRequest = import("../redteam/provider-config.ts").ProviderInput & {
  anotherAccount?: boolean;
};
export interface ChatgptLoginResult {
  id: string;
  state: "pending" | "connected" | "failed" | "cancelled";
  authorizationUrl?: string;
  provider: import("../redteam/provider-config.ts").SavedProvider;
  models: { id: string; name: string }[];
  error?: string;
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

/** Browser chrome colours matching each appearance's page background. */
export const THEME_COLORS = {
  dark: "#172b36",
  light: "#f1f6f4",
} as const satisfies Record<Exclude<DashboardTheme, "system">, string>;

/** The `color-scheme` value for a theme; System lets the browser follow the device. */
export function themeColorScheme(theme: DashboardTheme): string {
  return theme === "system" ? "light dark" : theme;
}

/** The `theme-color` metas for a theme. System has one per device setting. */
export function themeColorMetas(theme: DashboardTheme): { media?: string; content: string }[] {
  return theme === "system"
    ? [
        { media: "(prefers-color-scheme: dark)", content: THEME_COLORS.dark },
        { media: "(prefers-color-scheme: light)", content: THEME_COLORS.light },
      ]
    : [{ content: THEME_COLORS[theme] }];
}

/**
 * Rewrite the shell's `<html data-theme data-density>`, `color-scheme` and `theme-color`
 * so the saved appearance applies before any script runs. The service does this for
 * every HTML response; the Vite dev server does it for its transformed index.
 */
export function applyAppearanceToHtml(
  html: string,
  { theme, density }: DashboardAppearance,
): string {
  const colors = themeColorMetas(theme)
    .map(
      ({ media, content }) =>
        `<meta name="theme-color"${media ? ` media="${media}"` : ""} content="${content}" />`,
    )
    .join("");
  return html
    .replace(
      /<html\b([^>]*)>/i,
      (_match, attributes: string) =>
        `<html${attributes.replace(/\sdata-(theme|density)="[^"]*"/gi, "")} data-theme="${theme}" data-density="${density}">`,
    )
    .replace(
      /name="color-scheme" content="[^"]*"/,
      `name="color-scheme" content="${themeColorScheme(theme)}"`,
    )
    .replace(/<meta name="theme-color"[^>]*>/, colors);
}
