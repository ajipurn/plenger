import {
  type AddRepositoryRequest,
  API,
  type CancelResult,
  type ChatgptLoginRequest,
  type ChatgptLoginResult,
  type ChooseFolderResult,
  type DashboardDensity,
  type DashboardSession,
  type DashboardState,
  type DashboardTheme,
  type DeleteResult,
  type DensityResult,
  type ErrorResponse,
  type FindingStatus,
  type FixPromptRequest,
  type FixPromptResult,
  type ImportedReaEvidence,
  type LocalRepository,
  type ModelPricingRequest,
  type ModelPricingResult,
  type ModelWindowRequest,
  type ModelWindowResult,
  type PauseResult,
  type ProviderModelsRequest,
  type ProviderModelsResult,
  type ProviderTestResult,
  type ReaImportRequest,
  type RepositorySource,
  type ScanBudget,
  type ScanSourceFiles,
  type SecurityEvent,
  type SecurityFinding,
  type SecurityScan,
  type SecurityWorkspace,
  type StartSecurityScan,
  type ThemeResult,
  TOKEN_HEADER,
  TOKEN_LINK_PARAMETER,
  TOKEN_STORAGE_KEY,
  type UpdateRepositoryRequest,
} from "../../../src/dashboard/contract.ts";
import type { ProviderInput, SavedProvider } from "../../../src/redteam/provider-config.ts";
import { cacheModelPricing } from "./model-pricing-cache.ts";

export interface DashboardApi {
  session: DashboardSession;
  securityWorkspace(): Promise<SecurityWorkspace>;
  addRepository(input: AddRepositoryRequest): Promise<LocalRepository>;
  updateRepository(id: string, input: UpdateRepositoryRequest): Promise<LocalRepository>;
  deleteRepository(id: string): Promise<DeleteResult>;
  repositorySource(id: string, signal?: AbortSignal): Promise<RepositorySource>;
  startSecurityScan(input: StartSecurityScan): Promise<SecurityScan>;
  securityScan(id: string): Promise<SecurityScan>;
  scanSourceFiles(id: string, signal?: AbortSignal): Promise<ScanSourceFiles>;
  /**
   * Read pushed scan events until the stream ends or `signal` aborts. `onOpen` runs once
   * the service accepts the stream.
   */
  securityEvents(
    signal: AbortSignal,
    onEvent: (event: SecurityEvent) => void,
    onOpen: () => void,
  ): Promise<void>;
  cancelSecurityScan(id: string): Promise<CancelResult>;
  pauseSecurityScan(id: string): Promise<PauseResult>;
  /** Omit the limit only for a paused scan whose run had none. */
  continueSecurityScan(id: string, budget?: ScanBudget): Promise<SecurityScan>;
  setFindingStatus(id: string, status: FindingStatus): Promise<SecurityFinding>;
  initialState: DashboardState;
  chooseFolder(path: string, signal?: AbortSignal): Promise<ChooseFolderResult>;
  generateFixPrompt(input: FixPromptRequest, signal?: AbortSignal): Promise<FixPromptResult>;
  reaEvidence(scanId: string, signal?: AbortSignal): Promise<ImportedReaEvidence[]>;
  importReaEvidence(input: ReaImportRequest): Promise<ImportedReaEvidence>;
  deleteReaEvidence(scanId: string, id: string): Promise<DeleteResult>;
  clear(): Promise<DashboardState>;
  setTheme(theme: DashboardTheme): Promise<ThemeResult>;
  setDensity(density: DashboardDensity): Promise<DensityResult>;
  providers(): Promise<SavedProvider[]>;
  saveProvider(input: ProviderInput): Promise<SavedProvider>;
  deleteProvider(id: string): Promise<DeleteResult>;
  testProvider(id: string): Promise<ProviderTestResult>;
  providerModels(input: ProviderModelsRequest, signal?: AbortSignal): Promise<ProviderModelsResult>;
  cachedProviderModels(id: string, signal?: AbortSignal): Promise<ProviderModelsResult | null>;
  modelPricing(input: ModelPricingRequest, signal?: AbortSignal): Promise<ModelPricingResult>;
  modelWindow(input: ModelWindowRequest, signal?: AbortSignal): Promise<ModelWindowResult>;
  startChatgptLogin(input: ChatgptLoginRequest): Promise<ChatgptLoginResult>;
  chatgptLoginStatus(id: string): Promise<ChatgptLoginResult>;
  cancelChatgptLogin(id: string): Promise<ChatgptLoginResult>;
}

function withId(path: string, id: string): string {
  return `${path}?id=${encodeURIComponent(id)}`;
}

/** The page could not prove it was opened from the link the launcher printed. */
export class SessionLinkError extends Error {}

const SESSION_LINK_MESSAGE =
  "Open the dashboard with the link the plenger command printed in your terminal.";

/**
 * The session token: from the printed link's fragment, which is then removed from the
 * address bar, or as kept for this address by an earlier tab.
 */
function sessionToken(): string | null {
  const linked = new URLSearchParams(window.location.hash.slice(1)).get(TOKEN_LINK_PARAMETER);
  if (linked) {
    try {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, linked);
    } catch {
      // Storage may be unavailable; this tab still has the token.
    }
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${search}`);
    return linked;
  }
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * The service answers 403 only when the page's token or address is not its own: the
 * service restarted, or the token came from an earlier run on the same address.
 */
function sessionLost(): SessionLinkError {
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Nothing kept.
  }
  return new SessionLinkError(SESSION_LINK_MESSAGE);
}

const UNREACHABLE = "Unable to reach the local service. Check that plenger is still running.";

export async function connect(): Promise<DashboardApi> {
  const token = sessionToken();
  if (token === null) throw new SessionLinkError(SESSION_LINK_MESSAGE);
  const response = await fetch(API.session, {
    cache: "no-store",
    headers: { [TOKEN_HEADER]: token },
  });
  if (response.status === 403) throw sessionLost();
  if (!response.ok)
    throw new Error("Unable to connect to Plenger. Restart the dashboard and try again.");
  const session = (await response.json()) as DashboardSession;
  async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let result: Response;
    try {
      result = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        cache: "no-store",
        ...(signal ? { signal } : {}),
        headers: {
          [TOKEN_HEADER]: session.token,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      // An abort is the caller's; anything else means the service is gone.
      if (signal?.aborted) throw error;
      throw new Error(UNREACHABLE);
    }
    if (result.status === 403) throw sessionLost();
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
    deleteRepository: (id) =>
      request<DeleteResult>(API.deleteRepository.replace(":id", encodeURIComponent(id)), {}),
    repositorySource: (id, signal) =>
      request<RepositorySource>(
        API.repositorySource.replace(":id", encodeURIComponent(id)),
        undefined,
        signal,
      ),
    startSecurityScan: (input) => request<SecurityScan>(API.securityScans, input),
    securityScan: (id) =>
      request<SecurityScan>(API.securityScan.replace(":id", encodeURIComponent(id))),
    securityEvents: async (signal, onEvent, onOpen) => {
      // EventSource cannot send the session token header, so the stream is read by hand.
      const response = await fetch(API.securityEvents, {
        cache: "no-store",
        signal,
        headers: { [TOKEN_HEADER]: session.token },
      });
      if (response.status === 403) throw sessionLost();
      if (!response.ok || !response.body) throw new Error("Unable to open scan events.");
      onOpen();
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let pending = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          pending += chunk.value;
          const frames = pending.split("\n\n");
          pending = frames.pop() ?? "";
          for (const frame of frames) {
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (data) onEvent(JSON.parse(data) as SecurityEvent);
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
    scanSourceFiles: (id, signal) =>
      request<ScanSourceFiles>(
        API.scanSourceFiles.replace(":id", encodeURIComponent(id)),
        undefined,
        signal,
      ),
    cancelSecurityScan: (id) =>
      request<CancelResult>(API.cancelSecurityScan.replace(":id", encodeURIComponent(id)), {}),
    pauseSecurityScan: (id) =>
      request<PauseResult>(API.pauseSecurityScan.replace(":id", encodeURIComponent(id)), {}),
    continueSecurityScan: (id, budget) =>
      request<SecurityScan>(
        API.continueSecurityScan.replace(":id", encodeURIComponent(id)),
        budget ? { budget } : {},
      ),
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
    setDensity: (density) => request<DensityResult>(API.density, { density }),
    providers: () => request<SavedProvider[]>(API.providers),
    saveProvider: (input) => request<SavedProvider>(API.providers, input),
    deleteProvider: (id) => request<DeleteResult>(API.deleteProvider, { id }),
    testProvider: (id) => request<ProviderTestResult>(API.testProvider, { id }),
    providerModels: (input, signal) =>
      request<ProviderModelsResult>(API.providerModels, input, signal),
    modelPricing: cacheModelPricing((input, signal) =>
      request<ModelPricingResult>(API.modelPricing, input, signal),
    ),
    modelWindow: (input, signal) => request<ModelWindowResult>(API.modelWindow, input, signal),
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
