import type { CampaignReport } from "../redteam/campaign.ts";
import type { ProjectPlan } from "../redteam/plan.ts";
import type { ProviderInput, SavedProvider } from "../redteam/provider-config.ts";
import type { RedteamRun } from "../redteam/run.ts";
import { Storage } from "./database.ts";
import { EvidenceRepository } from "./evidence-repository.ts";
import { ProviderRepository, type ResolvedProvider } from "./provider-repository.ts";
import { providerEncryptionKey } from "./provider-secrets.ts";
import type {
  DashboardAppearance,
  DashboardDensity,
  DashboardScan,
  DashboardTheme,
  SavedRunProfile,
  WorkspaceSnapshot,
} from "./records.ts";
import { RedteamRepository } from "./redteam-repository.ts";
import { ReviewRepository } from "./review-repository.ts";
import { ScanRepository } from "./scan-repository.ts";
import { SecurityRepository } from "./security-repository.ts";

export { dashboardDataDirectory } from "./database.ts";
export { StoreValidationError } from "./errors.ts";
export { ProviderRepository, type ResolvedProvider } from "./provider-repository.ts";

/**
 * Disk-backed dashboard state, independent of the server's port or browser session.
 * One SQLite connection shared by feature repositories; this facade keeps the surface
 * the server and tests use in one place.
 */
export class DashboardStore {
  readonly scans: ScanRepository;
  readonly redteam: RedteamRepository;
  readonly providers: ProviderRepository;
  readonly evidence: EvidenceRepository;
  readonly reviews: ReviewRepository;
  readonly security: SecurityRepository;
  readonly #storage: Storage;

  private constructor(storage: Storage, providerKey: Buffer) {
    this.#storage = storage;
    this.scans = new ScanRepository(storage);
    this.redteam = new RedteamRepository(storage);
    this.providers = new ProviderRepository(storage, providerKey);
    this.evidence = new EvidenceRepository(storage);
    this.reviews = new ReviewRepository(storage);
    this.security = new SecurityRepository(storage);
  }

  /**
   * Open the dashboard's data directory and close any run or campaign a previous
   * dashboard process left in flight. The CLI opens `ProviderRepository` instead so
   * it never touches a live dashboard's work.
   */
  static async open(dataDir?: string): Promise<DashboardStore> {
    const storage = await Storage.open(dataDir);
    try {
      const providerKey = await providerEncryptionKey(storage.directory);
      const store = new DashboardStore(storage, providerKey);
      store.redteam.recoverInterrupted();
      store.security.recoverInterrupted();
      return store;
    } catch (error) {
      storage.close();
      throw error;
    }
  }

  /** Everything the page needs on load for the selected (or given) project. */
  read(fallbackProject: string): WorkspaceSnapshot {
    const project = this.scans.selectedProject(fallbackProject);
    return {
      theme: this.scans.readTheme(),
      density: this.scans.readDensity(),
      project,
      report: this.scans.readReport(project),
      plan: this.scans.readPlan(project),
      history: this.scans.history(),
      runs: this.redteam.readRuns(project),
      runProfile: this.redteam.readRunProfile(project),
      campaigns: this.redteam.readCampaigns(project),
    };
  }

  readTheme(): DashboardTheme {
    return this.scans.readTheme();
  }
  saveTheme(theme: DashboardTheme): void {
    this.scans.saveTheme(theme);
  }
  readDensity(): DashboardDensity {
    return this.scans.readDensity();
  }
  saveDensity(density: DashboardDensity): void {
    this.scans.saveDensity(density);
  }
  readAppearance(): DashboardAppearance {
    return { theme: this.readTheme(), density: this.readDensity() };
  }
  selectProject(project: string): void {
    this.scans.selectProject(project);
  }
  saveScan(result: DashboardScan): void {
    this.scans.saveScan(result);
  }
  savePlan(plan: ProjectPlan): void {
    this.scans.savePlan(plan);
  }
  openScan(id: string): boolean {
    return this.scans.openScan(id);
  }
  clear(): void {
    this.scans.clear();
  }

  saveRun(run: RedteamRun, profile?: SavedRunProfile): void {
    this.redteam.saveRun(run, profile);
  }
  readRuns(project: string): RedteamRun[] {
    return this.redteam.readRuns(project);
  }
  readRun(id: string): RedteamRun | null {
    return this.redteam.readRun(id);
  }
  saveCampaign(report: CampaignReport, profile?: SavedRunProfile): void {
    this.redteam.saveCampaign(report, profile);
  }
  readCampaign(id: string): CampaignReport | null {
    return this.redteam.readCampaign(id);
  }
  readCampaigns(project: string): CampaignReport[] {
    return this.redteam.readCampaigns(project);
  }
  readRunProfile(project: string): SavedRunProfile | null {
    return this.redteam.readRunProfile(project);
  }

  readProviders(options: { keyPreviews?: boolean; pricingCache?: boolean } = {}): SavedProvider[] {
    return this.providers.readProviders(options);
  }
  saveProvider(value: ProviderInput): SavedProvider {
    return this.providers.saveProvider(value);
  }
  deleteProvider(id: string): boolean {
    return this.providers.deleteProvider(id);
  }
  resolveProvider(id: string): ResolvedProvider {
    return this.providers.resolveProvider(id);
  }

  close(): void {
    this.#storage.close();
  }
}
