import type { ProjectPlan } from "../redteam/plan.ts";
import { parsePayload, type Storage, textColumn } from "./database.ts";
import {
  type DashboardDensity,
  type DashboardScan,
  type DashboardScanSummary,
  type DashboardTheme,
  isDashboardDensity,
  isDashboardTheme,
} from "./records.ts";

/** Projects, scan snapshots, target plans, the selected workspace and the theme. */
export class ScanRepository {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  /** The last selected project, or `fallback` when nothing was selected yet. */
  selectedProject(fallback: string): string {
    const row = this.#storage.database.prepare("SELECT project FROM workspace WHERE id = 1").get();
    return row ? textColumn(row, "project") : fallback;
  }

  /** The scan currently shown for `project` (its latest, or one reopened from history). */
  readReport(project: string): DashboardScan | null {
    const row = this.#storage.database
      .prepare(
        `SELECT scans.payload FROM projects JOIN scans ON scans.id = projects.scan_id
         WHERE projects.path = ? AND scans.project = projects.path`,
      )
      .get(project);
    return row ? parsePayload<DashboardScan>(row) : null;
  }

  /** Read a snapshot without changing the selected project or scan. */
  readScan(id: string): DashboardScan | null {
    const row = this.#storage.database.prepare("SELECT payload FROM scans WHERE id = ?").get(id);
    return row ? parsePayload<DashboardScan>(row) : null;
  }

  readPlan(project: string): ProjectPlan | null {
    const row = this.#storage.database
      .prepare("SELECT plan FROM projects WHERE path = ? AND plan IS NOT NULL")
      .get(project);
    if (!row) return null;
    const plan = parsePayload<ProjectPlan>(row, "plan");
    // A plan saved before test-pack binding existed is reviewed again on the next request.
    return plan.targets.every((target) => Array.isArray(target.packs)) ? plan : null;
  }

  /** Every saved scan across projects, newest first, without payloads. */
  history(): DashboardScanSummary[] {
    return this.#storage.database
      .prepare(
        "SELECT id, created_at AS createdAt, project, findings, files FROM scans ORDER BY sequence DESC",
      )
      .all()
      .map((row) => ({
        id: textColumn(row, "id"),
        createdAt: textColumn(row, "createdAt"),
        project: textColumn(row, "project"),
        findings: Number(row.findings),
        files: Number(row.files),
      }));
  }

  readTheme(): DashboardTheme {
    const theme = this.#storage.database
      .prepare("SELECT theme FROM preferences WHERE id = 1")
      .get()?.theme;
    return isDashboardTheme(theme) ? theme : "dark";
  }

  saveTheme(theme: DashboardTheme): void {
    this.#storage.database
      .prepare(
        "INSERT INTO preferences (id, theme) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET theme = excluded.theme",
      )
      .run(theme);
  }

  readDensity(): DashboardDensity {
    const density = this.#storage.database
      .prepare("SELECT density FROM preferences WHERE id = 1")
      .get()?.density;
    return isDashboardDensity(density) ? density : "comfortable";
  }

  saveDensity(density: DashboardDensity): void {
    this.#storage.database
      .prepare(
        "INSERT INTO preferences (id, theme, density) VALUES (1, 'dark', ?) ON CONFLICT (id) DO UPDATE SET density = excluded.density",
      )
      .run(density);
  }

  selectProject(project: string): void {
    this.#storage.transaction(() => this.#select(project));
  }

  /** Record a finished scan, make its project current and drop that project's stale plan. */
  saveScan(result: DashboardScan): void {
    this.#storage.transaction(() => {
      const project = result.scan.root;
      this.#select(project);
      this.#storage.database
        .prepare(
          "INSERT INTO scans (id, project, created_at, findings, files, payload) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          result.id,
          project,
          result.createdAt,
          result.scan.findings.length,
          result.scan.files.length,
          JSON.stringify(result),
        );
      this.#storage.database
        .prepare("UPDATE projects SET scan_id = ?, plan = NULL WHERE path = ?")
        .run(result.id, project);
    });
  }

  savePlan(plan: ProjectPlan): void {
    this.#storage.transaction(() => {
      this.#select(plan.root);
      this.#storage.database
        .prepare("UPDATE projects SET plan = ? WHERE path = ?")
        .run(JSON.stringify(plan), plan.root);
    });
  }

  /** Show a saved scan again and switch to its project. False when it no longer exists. */
  openScan(id: string): boolean {
    const scan = this.#storage.database.prepare("SELECT project FROM scans WHERE id = ?").get(id);
    if (!scan) return false;
    const project = textColumn(scan, "project");
    this.#storage.transaction(() => {
      this.#select(project);
      this.#storage.database
        .prepare("UPDATE projects SET scan_id = ? WHERE path = ?")
        .run(id, project);
    });
    return true;
  }

  /**
   * Forget every project. Scans, the workspace selection, red-team runs, campaigns and
   * run profiles all reference `projects(path) ON DELETE CASCADE`, so deleting projects
   * removes them too (`foreign_keys` is ON for this connection). Saved providers are
   * global settings and are kept; each is deleted from Settings. The theme is kept.
   */
  clear(): void {
    this.#storage.transaction(() => {
      this.#storage.database.exec(
        "DELETE FROM workspace; DELETE FROM projects; DELETE FROM scans;",
      );
    });
    // Deleted rows must not linger in the write-ahead log.
    this.#storage.database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }

  #select(project: string): void {
    this.#storage.ensureProject(project);
    this.#storage.database
      .prepare(
        "INSERT INTO workspace (id, project) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET project = excluded.project",
      )
      .run(project);
  }
}
