import { type CampaignReport, interruptCampaign } from "../redteam/campaign.ts";
import { interruptRun, isRunActive, type RedteamRun } from "../redteam/run.ts";
import { parsePayload, type Storage, textColumn } from "./database.ts";
import type { SavedRunProfile } from "./records.ts";

const RECENT = 20;

/** Managed runs, repeated campaigns and the last-used settings of each project. */
export class RedteamRepository {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  saveRun(run: RedteamRun, profile?: SavedRunProfile): void {
    this.#storage.transaction(() => {
      this.#storage.ensureProject(run.root);
      this.#storage.database
        .prepare(
          "INSERT INTO redteam_runs (id, project, created_at, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
        )
        .run(run.id, run.root, run.createdAt, JSON.stringify(run));
      if (profile) this.#writeProfile(run.root, profile);
    });
  }

  readRuns(project: string): RedteamRun[] {
    return this.#storage.database
      .prepare(
        "SELECT payload FROM redteam_runs WHERE project = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(project, RECENT)
      .map((row) => parsePayload<RedteamRun>(row));
  }

  readRun(id: string): RedteamRun | null {
    const row = this.#storage.database
      .prepare("SELECT payload FROM redteam_runs WHERE id = ?")
      .get(id);
    return row ? parsePayload<RedteamRun>(row) : null;
  }

  saveCampaign(report: CampaignReport, profile?: SavedRunProfile): void {
    this.#storage.transaction(() => {
      this.#storage.ensureProject(report.plan.root);
      this.#storage.database
        .prepare(
          "INSERT INTO redteam_campaigns (id, project, created_at, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
        )
        .run(report.id, report.plan.root, report.createdAt, JSON.stringify(report));
      if (profile) this.#writeProfile(report.plan.root, profile);
    });
  }

  readCampaign(id: string): CampaignReport | null {
    const row = this.#storage.database
      .prepare("SELECT payload FROM redteam_campaigns WHERE id = ?")
      .get(id);
    return row ? parsePayload<CampaignReport>(row) : null;
  }

  readCampaigns(project: string): CampaignReport[] {
    return this.#storage.database
      .prepare(
        "SELECT payload FROM redteam_campaigns WHERE project = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(project, RECENT)
      .map((row) => parsePayload<CampaignReport>(row));
  }

  readRunProfile(project: string): SavedRunProfile | null {
    const row = this.#storage.database
      .prepare("SELECT payload FROM redteam_profiles WHERE project = ?")
      .get(project);
    return row ? parsePayload<SavedRunProfile>(row) : null;
  }

  /**
   * Crash recovery: anything still `preparing` or `running` when this process opens
   * the database belonged to a dashboard that is gone. Mark it stopped with cleanup
   * unconfirmed; recorded violations are kept and still count toward the gate.
   */
  recoverInterrupted(): void {
    this.#storage.transaction(() => {
      const campaigns = this.#storage.database.prepare(
        "UPDATE redteam_campaigns SET payload = ? WHERE id = ?",
      );
      for (const row of this.#storage.database
        .prepare("SELECT id, payload FROM redteam_campaigns")
        .all()) {
        const report = parsePayload<CampaignReport>(row);
        if (!isRunActive(report)) continue;
        interruptCampaign(report, "Local service stopped; worker cleanup could not be confirmed.");
        campaigns.run(JSON.stringify(report), textColumn(row, "id"));
      }
      const runs = this.#storage.database.prepare(
        "UPDATE redteam_runs SET payload = ? WHERE id = ?",
      );
      for (const row of this.#storage.database
        .prepare("SELECT id, payload FROM redteam_runs")
        .all()) {
        const run = parsePayload<RedteamRun>(row);
        if (!isRunActive(run)) continue;
        interruptRun(run, "Dashboard restarted before run cleanup could be confirmed.");
        runs.run(JSON.stringify(run), textColumn(row, "id"));
      }
    });
  }

  /** Only allow-listed settings are kept; a key supplied with a run is never written. */
  #writeProfile(project: string, profile: SavedRunProfile): void {
    const payload: SavedRunProfile = {
      ...(profile.providerId ? { providerId: profile.providerId } : {}),
      target: profile.target,
      provider: profile.provider,
      model: profile.model,
      limits: {
        maxModelCalls: profile.limits.maxModelCalls,
        maxTokens: profile.limits.maxTokens,
        timeoutMs: profile.limits.timeoutMs,
      },
      ...(profile.repetitions !== undefined ? { repetitions: profile.repetitions } : {}),
      ...(profile.policy ? { policy: structuredClone(profile.policy) } : {}),
    };
    this.#storage.database
      .prepare(
        "INSERT INTO redteam_profiles (project, payload) VALUES (?, ?) ON CONFLICT(project) DO UPDATE SET payload = excluded.payload",
      )
      .run(project, JSON.stringify(payload));
  }
}
