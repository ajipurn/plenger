import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ProjectPlan } from "../redteam/plan.ts";
import type { RedteamRun } from "../redteam/run.ts";
import type {
  DashboardScan,
  DashboardScanSummary,
  DashboardState,
  DashboardTheme,
  SavedRunProfile,
} from "./model.ts";

export function dashboardDataDirectory(): string {
  if (process.platform === "darwin") return join(homedir(), "Library/Application Support/plenger");
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData/Local"), "plenger");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "plenger");
}

/** Disk-backed snapshots, independent of the server's port or browser session. */
export class DashboardStore {
  private readonly database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.database = database;
  }

  static async open(dataDir = dashboardDataDirectory()): Promise<DashboardStore> {
    const directory = resolve(dataDir);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, "dashboard.sqlite");
    try {
      await writeFile(file, "", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    if (!(await lstat(file)).isFile())
      throw new Error("Dashboard database must be a regular file.");
    await chmod(file, 0o600);
    // Load SQLite only for serve; ordinary CLI scans keep their current startup behavior.
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(file, { timeout: 5000 });
    try {
      database.exec(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON;",
      );
      database.exec("BEGIN IMMEDIATE");
      const version = database.prepare("PRAGMA user_version").get()?.user_version;
      if (version === 0) {
        database.exec(`
          CREATE TABLE projects (
            path TEXT PRIMARY KEY,
            scan_id TEXT REFERENCES scans(id) ON DELETE SET NULL,
            plan TEXT
          ) STRICT;
          CREATE TABLE scans (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            project TEXT NOT NULL REFERENCES projects(path) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            findings INTEGER NOT NULL,
            files INTEGER NOT NULL,
            payload TEXT NOT NULL
          ) STRICT;
          CREATE TABLE workspace (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            project TEXT NOT NULL REFERENCES projects(path) ON DELETE CASCADE
          ) STRICT;
          PRAGMA user_version = 1;
        `);
      } else if (version !== 1 && version !== 2 && version !== 3) {
        throw new Error(
          "Dashboard database version is unsupported. Use a compatible Plenger version.",
        );
      }
      if (version === 0 || version === 1) {
        database.exec(`
          CREATE TABLE preferences (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            theme TEXT NOT NULL CHECK (theme IN ('dark', 'light'))
          ) STRICT;
          INSERT INTO preferences (id, theme) VALUES (1, 'dark');
          PRAGMA user_version = 2;
        `);
      }
      if (version === 0 || version === 1 || version === 2) {
        database.exec(`
          CREATE TABLE IF NOT EXISTS redteam_runs (
            id TEXT PRIMARY KEY,
            project TEXT NOT NULL REFERENCES projects(path) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            payload TEXT NOT NULL
          ) STRICT;
          CREATE TABLE IF NOT EXISTS redteam_profiles (
            project TEXT PRIMARY KEY REFERENCES projects(path) ON DELETE CASCADE,
            payload TEXT NOT NULL
          ) STRICT;
          PRAGMA user_version = 3;
        `);
      }
      for (const row of database.prepare("SELECT id, payload FROM redteam_runs").all()) {
        const run = JSON.parse(row.payload as string) as RedteamRun;
        if (run.state === "preparing" || run.state === "running") {
          run.state = "stopped";
          run.finishedAt = new Date().toISOString();
          run.cleanupConfirmed = false;
          run.error = "Dashboard restarted before run cleanup could be confirmed.";
          database
            .prepare("UPDATE redteam_runs SET payload = ? WHERE id = ?")
            .run(JSON.stringify(run), row.id as string);
        }
      }
      database.exec("COMMIT");
      return new DashboardStore(database);
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      database.close();
      throw error;
    }
  }

  read(fallbackProject: string): DashboardState {
    const selected = this.database.prepare("SELECT project FROM workspace WHERE id = 1").get();
    const project = (selected?.project as string | undefined) ?? fallbackProject;
    const current = this.database
      .prepare("SELECT scan_id, plan FROM projects WHERE path = ?")
      .get(project);
    const report = current?.scan_id
      ? this.database
          .prepare("SELECT payload FROM scans WHERE id = ? AND project = ?")
          .get(current.scan_id, project)
      : undefined;
    const history = this.database
      .prepare(`
      SELECT id, created_at AS createdAt, project, findings, files
      FROM scans ORDER BY sequence DESC
    `)
      .all() as unknown as DashboardScanSummary[];
    return {
      theme: this.readTheme(),
      project,
      report: report ? (JSON.parse(report.payload as string) as DashboardScan) : null,
      plan: current?.plan ? (JSON.parse(current.plan as string) as ProjectPlan) : null,
      history,
      runs: this.readRuns(project),
      runProfile: this.readRunProfile(project),
    };
  }

  readTheme(): DashboardTheme {
    return (
      (this.database.prepare("SELECT theme FROM preferences WHERE id = 1").get()?.theme as
        | DashboardTheme
        | undefined) ?? "dark"
    );
  }

  saveTheme(theme: DashboardTheme): void {
    this.database
      .prepare(`
      INSERT INTO preferences (id, theme) VALUES (1, ?)
      ON CONFLICT (id) DO UPDATE SET theme = excluded.theme
    `)
      .run(theme);
  }

  selectProject(project: string): void {
    this.transaction(() => this.select(project));
  }

  saveScan(result: DashboardScan): void {
    this.transaction(() => {
      const project = result.scan.root;
      this.select(project);
      this.database
        .prepare(`
        INSERT INTO scans (id, project, created_at, findings, files, payload)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
        .run(
          result.id,
          project,
          result.createdAt,
          result.scan.findings.length,
          result.scan.files.length,
          JSON.stringify(result),
        );
      this.database
        .prepare("UPDATE projects SET scan_id = ?, plan = NULL WHERE path = ?")
        .run(result.id, project);
    });
  }

  savePlan(plan: ProjectPlan): void {
    this.transaction(() => {
      this.select(plan.root);
      this.database
        .prepare("UPDATE projects SET plan = ? WHERE path = ?")
        .run(JSON.stringify(plan), plan.root);
    });
  }

  saveRun(run: RedteamRun, profile?: SavedRunProfile): void {
    this.transaction(() => {
      this.database
        .prepare("INSERT INTO projects (path) VALUES (?) ON CONFLICT DO NOTHING")
        .run(run.root);
      this.database
        .prepare(
          "INSERT INTO redteam_runs (id, project, created_at, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
        )
        .run(run.id, run.root, run.createdAt, JSON.stringify(run));
      if (profile) this.writeRunProfile(run.root, profile);
    });
  }

  readRuns(project: string): RedteamRun[] {
    return this.database
      .prepare(
        "SELECT payload FROM redteam_runs WHERE project = ? ORDER BY created_at DESC, id DESC LIMIT 20",
      )
      .all(project)
      .map((row) => JSON.parse(row.payload as string) as RedteamRun);
  }

  readRun(id: string): RedteamRun | null {
    const row = this.database.prepare("SELECT payload FROM redteam_runs WHERE id = ?").get(id);
    return row ? (JSON.parse(row.payload as string) as RedteamRun) : null;
  }

  saveRunProfile(project: string, profile: SavedRunProfile): void {
    this.transaction(() => {
      this.database
        .prepare("INSERT INTO projects (path) VALUES (?) ON CONFLICT DO NOTHING")
        .run(project);
      this.writeRunProfile(project, profile);
    });
  }

  private writeRunProfile(project: string, profile: SavedRunProfile): void {
    const payload: SavedRunProfile = {
      target: profile.target,
      provider: profile.provider,
      model: profile.model,
      limits: {
        maxModelCalls: profile.limits.maxModelCalls,
        maxTokens: profile.limits.maxTokens,
        timeoutMs: profile.limits.timeoutMs,
      },
    };
    this.database
      .prepare(
        "INSERT INTO redteam_profiles (project, payload) VALUES (?, ?) ON CONFLICT(project) DO UPDATE SET payload = excluded.payload",
      )
      .run(project, JSON.stringify(payload));
  }

  readRunProfile(project: string): SavedRunProfile | null {
    const row = this.database
      .prepare("SELECT payload FROM redteam_profiles WHERE project = ?")
      .get(project);
    return row ? (JSON.parse(row.payload as string) as SavedRunProfile) : null;
  }

  openScan(id: string): boolean {
    const scan = this.database.prepare("SELECT project FROM scans WHERE id = ?").get(id);
    if (!scan) return false;
    this.transaction(() => {
      const project = scan.project as string;
      this.select(project);
      this.database.prepare("UPDATE projects SET scan_id = ? WHERE path = ?").run(id, project);
    });
    return true;
  }

  clear(): void {
    this.transaction(() => {
      this.database.exec("DELETE FROM workspace; DELETE FROM projects; DELETE FROM scans;");
    });
    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }

  close(): void {
    this.database.close();
  }

  private select(project: string): void {
    this.database
      .prepare("INSERT INTO projects (path) VALUES (?) ON CONFLICT DO NOTHING")
      .run(project);
    this.database
      .prepare(`
      INSERT INTO workspace (id, project) VALUES (1, ?)
      ON CONFLICT (id) DO UPDATE SET project = excluded.project
    `)
      .run(project);
  }

  private transaction(write: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      write();
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
