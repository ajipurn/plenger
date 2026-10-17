import {
  type AddRepositoryRequest,
  API,
  type CancelResult,
  type ChatgptLoginResult,
  type ChooseFolderResult,
  type DashboardSession,
  type DashboardState,
  type DashboardTheme,
  type DeleteResult,
  type ErrorResponse,
  type FindingStatus,
  type FixPromptRequest,
  type FixPromptResult,
  type ImportedReaEvidence,
  type LocalRepository,
  type ProviderModelsRequest,
  type ProviderModelsResult,
  type ProviderTestResult,
  type ReaImportRequest,
  type RepositorySource,
  type SecurityFinding,
  type SecurityScan,
  type SecurityWorkspace,
  type StartSecurityScan,
  type ThemeResult,
  TOKEN_HEADER,
  type UpdateRepositoryRequest,
} from "../../../src/dashboard/contract.ts";
import type { ProviderInput, SavedProvider } from "../../../src/redteam/provider-config.ts";

export interface DashboardApi {
  session: DashboardSession;
  securityWorkspace(): Promise<SecurityWorkspace>;
  addRepository(input: AddRepositoryRequest): Promise<LocalRepository>;
  updateRepository(id: string, input: UpdateRepositoryRequest): Promise<LocalRepository>;
  repositorySource(id: string, signal?: AbortSignal): Promise<RepositorySource>;
  startSecurityScan(input: StartSecurityScan): Promise<SecurityScan>;
  securityScan(id: string): Promise<SecurityScan>;
  cancelSecurityScan(id: string): Promise<CancelResult>;
  setFindingStatus(id: string, status: FindingStatus): Promise<SecurityFinding>;
  initialState: DashboardState;
  chooseFolder(path: string, signal?: AbortSignal): Promise<ChooseFolderResult>;
  generateFixPrompt(input: FixPromptRequest, signal?: AbortSignal): Promise<FixPromptResult>;
  reaEvidence(scanId: string, signal?: AbortSignal): Promise<ImportedReaEvidence[]>;
  importReaEvidence(input: ReaImportRequest): Promise<ImportedReaEvidence>;
  deleteReaEvidence(scanId: string, id: string): Promise<DeleteResult>;
  clear(): Promise<DashboardState>;
  setTheme(theme: DashboardTheme): Promise<ThemeResult>;
  providers(): Promise<SavedProvider[]>;
  saveProvider(input: ProviderInput): Promise<SavedProvider>;
  deleteProvider(id: string): Promise<DeleteResult>;
  testProvider(id: string): Promise<ProviderTestResult>;
  providerModels(input: ProviderModelsRequest, signal?: AbortSignal): Promise<ProviderModelsResult>;
  cachedProviderModels(id: string, signal?: AbortSignal): Promise<ProviderModelsResult | null>;
  startChatgptLogin(input: ProviderInput): Promise<ChatgptLoginResult>;
  chatgptLoginStatus(id: string): Promise<ChatgptLoginResult>;
  cancelChatgptLogin(id: string): Promise<ChatgptLoginResult>;
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
    securityWorkspace: () => request<SecurityWorkspace>(API.securityWorkspace),
    addRepository: (input) => request<LocalRepository>(API.repositories, input),
    updateRepository: (id, input) =>
      request<LocalRepository>(API.updateRepository.replace(":id", encodeURIComponent(id)), input),
    repositorySource: (id, signal) =>
      request<RepositorySource>(
        API.repositorySource.replace(":id", encodeURIComponent(id)),
        undefined,
        signal,
      ),
    startSecurityScan: (input) => request<SecurityScan>(API.securityScans, input),
    securityScan: (id) =>
      request<SecurityScan>(API.securityScan.replace(":id", encodeURIComponent(id))),
    cancelSecurityScan: (id) =>
      request<CancelResult>(API.cancelSecurityScan.replace(":id", encodeURIComponent(id)), {}),
    setFindingStatus: (id, status) =>
      request<SecurityFinding>(API.findingStatus.replace(":id", encodeURIComponent(id)), {
        status,
      }),
    initialState: await request<DashboardState>(API.state),
    chooseFolder: (path, signal) => request<ChooseFolderResult>(API.chooseFolder, { path }, signal),
    generateFixPrompt: (input, signal) =>
      request<FixPromptResult>(API.generateFixPrompt, input, signal),
    reaEvidence: (scanId, signal) =>
      request<ImportedReaEvidence[]>(
        `${API.reaEvidence}?scanId=${encodeURIComponent(scanId)}`,
        undefined,
        signal,
      ),
    importReaEvidence: (input) => request<ImportedReaEvidence>(API.reaEvidence, input),
    deleteReaEvidence: (scanId, id) => request<DeleteResult>(API.deleteReaEvidence, { scanId, id }),
    clear: () => request<DashboardState>(API.clear, {}),
    setTheme: (theme) => request<ThemeResult>(API.theme, { theme }),
    providers: () => request<SavedProvider[]>(API.providers),
    saveProvider: (input) => request<SavedProvider>(API.providers, input),
    deleteProvider: (id) => request<DeleteResult>(API.deleteProvider, { id }),
    testProvider: (id) => request<ProviderTestResult>(API.testProvider, { id }),
    providerModels: (input, signal) =>
      request<ProviderModelsResult>(API.providerModels, input, signal),
    cachedProviderModels: (id, signal) =>
      request<ProviderModelsResult | null>(
        `${API.providerModels}?id=${encodeURIComponent(id)}`,
        undefined,
        signal,
      ),
    startChatgptLogin: (input) => request<ChatgptLoginResult>(API.chatgptLogin, input),
    chatgptLoginStatus: (id) => request<ChatgptLoginResult>(withId(API.chatgptLoginStatus, id)),
    cancelChatgptLogin: (id) => request<ChatgptLoginResult>(API.cancelChatgptLogin, { id }),
  };
}
