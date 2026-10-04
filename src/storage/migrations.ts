import type { DatabaseSync } from "node:sqlite";

/**
 * Schema steps in order: `MIGRATIONS[n]` upgrades a database at `user_version` n to
 * n + 1. `openStorage` applies the missing tail inside one transaction. Steps are
 * append-only; a shipped step is never edited because installed databases record
 * only the version number, not the statements that produced their schema.
 *
 * Later steps use `IF NOT EXISTS` so a database whose version was rolled back by a
 * repair still upgrades cleanly.
 */
export const MIGRATIONS: ((database: DatabaseSync) => void)[] = [
  // 0 -> 1: projects, scan snapshots and the single selected workspace project.
  (database) =>
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
    `),
  // 1 -> 2: the global theme preference, dark by default.
  (database) =>
    database.exec(`
      CREATE TABLE preferences (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        theme TEXT NOT NULL CHECK (theme IN ('dark', 'light'))
      ) STRICT;
      INSERT INTO preferences (id, theme) VALUES (1, 'dark');
    `),
  // 2 -> 3: managed red-team runs and the last run settings per project.
  (database) =>
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
    `),
  // 3 -> 4: saved model connections; the credential column holds the sealed key.
  (database) =>
    database.exec(`
      CREATE TABLE IF NOT EXISTS model_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
        payload TEXT NOT NULL,
        credential TEXT
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_default_provider ON model_providers(is_default) WHERE is_default = 1;
    `),
  // 4 -> 5: repeated campaigns.
  (database) =>
    database.exec(`
      CREATE TABLE IF NOT EXISTS redteam_campaigns (
        id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(path) ON DELETE CASCADE,
        created_at TEXT NOT NULL, payload TEXT NOT NULL
      ) STRICT;
    `),
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Bring `database` to the current schema, or refuse one written by a newer Plenger. */
export function migrate(database: DatabaseSync): void {
  const recorded = database.prepare("PRAGMA user_version").get()?.user_version;
  const version = typeof recorded === "number" ? recorded : Number.NaN;
  if (!Number.isInteger(version) || version < 0 || version > SCHEMA_VERSION)
    throw new Error("Dashboard database version is unsupported. Use a compatible Plenger version.");
  for (const [index, step] of MIGRATIONS.entries()) {
    if (index < version) continue;
    step(database);
    // PRAGMA cannot be parameterised; `index` is a trusted array position.
    database.exec(`PRAGMA user_version = ${index + 1}`);
  }
}
