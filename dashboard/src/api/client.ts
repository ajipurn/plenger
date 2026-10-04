import {
  API,
  type CancelResult,
  type ChooseFolderResult,
  type DashboardScan,
  type DashboardSession,
  type DashboardState,
  type DashboardTheme,
  type DeleteResult,
  type ErrorResponse,
  type FolderListing,
  type ProviderTestResult,
  type StartCampaignRequest,
  type StartRunRequest,
  type ThemeResult,
  TOKEN_HEADER,
} from "../../../src/dashboard/contract.ts";
import type { CampaignReport } from "../../../src/redteam/campaign.ts";
import type { ProjectPlan } from "../../../src/redteam/plan.ts";
import type { ProviderInput, SavedProvider } from "../../../src/redteam/provider-config.ts";
import type { RedteamRun } from "../../../src/redteam/run.ts";

export interface DashboardApi {
  session: DashboardSession;
  initialState: DashboardState;
  folders(path?: string): Promise<FolderListing>;
  chooseFolder(path: string, signal?: AbortSignal): Promise<ChooseFolderResult>;
  scan(path: string): Promise<DashboardScan>;
  plan(path: string, target?: string): Promise<ProjectPlan>;
  selectProject(path: string): Promise<DashboardState>;
  openScan(id: string): Promise<DashboardState>;
  clear(): Promise<DashboardState>;
  setTheme(theme: DashboardTheme): Promise<ThemeResult>;
  providers(): Promise<SavedProvider[]>;
  saveProvider(input: ProviderInput): Promise<SavedProvider>;
  deleteProvider(id: string): Promise<DeleteResult>;
  testProvider(id: string): Promise<ProviderTestResult>;
  startRun(config: StartRunRequest): Promise<RedteamRun>;
  getRun(id: string): Promise<RedteamRun>;
  startCampaign(config: StartCampaignRequest): Promise<CampaignReport>;
  getCampaign(id: string): Promise<CampaignReport>;
  cancelRun(id: string): Promise<CancelResult>;
}

function withId(path: string, id: string): string {
  return `${path}?id=${encodeURIComponent(id)}`;
}

export async function connect(): Promise<DashboardApi> {
  const response = await fetch(API.session, { cache: "no-store" });
  if (!response.ok)
    throw new Error("Unable to connect to Plenger. Restart the dashboard and try again.");
  const session = (await response.json()) as DashboardSession;
  async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const result = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      ...(signal ? { signal } : {}),
      headers: {
        [TOKEN_HEADER]: session.token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = (await result.json()) as Partial<ErrorResponse>;
    if (!result.ok) throw new Error(value.error ?? "Unable to complete this request. Try again.");
    return value as T;
  }
  return {
    session,
    initialState: await request<DashboardState>(API.state),
    folders: (path) =>
      request<FolderListing>(
        path ? `${API.folders}?path=${encodeURIComponent(path)}` : API.folders,
      ),
    chooseFolder: (path, signal) => request<ChooseFolderResult>(API.chooseFolder, { path }, signal),
    scan: (path) => request<DashboardScan>(API.scan, { path }),
    plan: (path, target) => request<ProjectPlan>(API.plan, { path, ...(target ? { target } : {}) }),
    selectProject: (path) => request<DashboardState>(API.project, { path }),
    openScan: (id) => request<DashboardState>(API.openScan, { id }),
    clear: () => request<DashboardState>(API.clear, {}),
    setTheme: (theme) => request<ThemeResult>(API.theme, { theme }),
    providers: () => request<SavedProvider[]>(API.providers),
    saveProvider: (input) => request<SavedProvider>(API.providers, input),
    deleteProvider: (id) => request<DeleteResult>(API.deleteProvider, { id }),
    testProvider: (id) => request<ProviderTestResult>(API.testProvider, { id }),
    startRun: (config) => request<RedteamRun>(API.startRun, config),
    getRun: (id) => request<RedteamRun>(withId(API.run, id)),
    startCampaign: (config) => request<CampaignReport>(API.startCampaign, config),
    getCampaign: (id) => request<CampaignReport>(withId(API.campaign, id)),
    cancelRun: (id) => request<CancelResult>(API.cancel, { id }),
  };
}
