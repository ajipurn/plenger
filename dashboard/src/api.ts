import type {
  DashboardScan,
  DashboardSession,
  DashboardState,
  DashboardTheme,
  FolderListing,
} from "../../src/dashboard/model.ts";
import type { BudgetLimits } from "../../src/redteam/budget.ts";
import type { ProjectPlan } from "../../src/redteam/plan.ts";
import type { ProviderAccess } from "../../src/redteam/provider.ts";
import type { RedteamRun } from "../../src/redteam/run.ts";

export interface DashboardApi {
  session: DashboardSession;
  initialState: DashboardState;
  folders(path?: string): Promise<FolderListing>;
  chooseFolder(path: string, signal?: AbortSignal): Promise<{ folder: FolderListing | null }>;
  scan(path: string): Promise<DashboardScan>;
  plan(path: string, target?: string): Promise<ProjectPlan>;
  selectProject(path: string): Promise<DashboardState>;
  openScan(id: string): Promise<DashboardState>;
  clear(): Promise<DashboardState>;
  setTheme(theme: DashboardTheme): Promise<{ theme: DashboardTheme }>;
  startRun(
    config: ProviderAccess & {
      path: string;
      target: string;
      sourceDigest: string;
      limits: BudgetLimits;
    },
  ): Promise<RedteamRun>;
  getRun(id: string): Promise<RedteamRun>;
  cancelRun(id: string): Promise<{ cancelled: boolean }>;
}

export async function connect(): Promise<DashboardApi> {
  const response = await fetch("/api/session", { cache: "no-store" });
  if (!response.ok)
    throw new Error("Unable to connect to Plenger. Restart the dashboard and try again.");
  const session = (await response.json()) as DashboardSession;
  async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const result = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      ...(signal ? { signal } : {}),
      headers: {
        "X-Plenger-Token": session.token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = (await result.json()) as { error?: string };
    if (!result.ok) throw new Error(value.error ?? "Unable to complete this request. Try again.");
    return value as T;
  }
  return {
    session,
    initialState: await request<DashboardState>("/api/state"),
    folders: (path) =>
      request<FolderListing>(`/api/folders${path ? `?path=${encodeURIComponent(path)}` : ""}`),
    chooseFolder: (path, signal) =>
      request<{ folder: FolderListing | null }>("/api/folders/choose", { path }, signal),
    scan: (path) => request<DashboardScan>("/api/scan", { path }),
    plan: (path, target) =>
      request<ProjectPlan>("/api/plan", { path, ...(target ? { target } : {}) }),
    selectProject: (path) => request<DashboardState>("/api/project", { path }),
    openScan: (id) => request<DashboardState>("/api/history/open", { id }),
    clear: () => request<DashboardState>("/api/state/clear", {}),
    setTheme: (theme) => request<{ theme: DashboardTheme }>("/api/theme", { theme }),
    startRun: (config) => request<RedteamRun>("/api/redteam/start", config),
    getRun: (id) => request<RedteamRun>(`/api/redteam/run?id=${encodeURIComponent(id)}`),
    cancelRun: (id) => request<{ cancelled: boolean }>("/api/redteam/cancel", { id }),
  };
}
