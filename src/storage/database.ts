import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { isErrno } from "../shared/guards.ts";
import { migrate } from "./migrations.ts";

export type Row = Record<string, SQLOutputValue>;

export function dashboardDataDirectory(): string {
  if (process.platform === "darwin") return join(homedir(), "Library/Application Support/plenger");
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData/Local"), "plenger");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "plenger");
}

/** The JSON document stored in `column` (default `payload`) of a row. */
export function parsePayload<T>(row: Row, column = "payload"): T {
  const value = row[column];
  if (typeof value !== "string")
    throw new Error(`Dashboard database column ${column} does not hold a JSON document.`);
  return JSON.parse(value) as T;
}

/** The text in `column` of a row, which the schema declares NOT NULL. */
export function textColumn(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string")
    throw new Error(`Dashboard database column ${column} does not hold text.`);
  return value;
}

/**
 * One open SQLite connection at the current schema, shared by the repositories.
 * Only the facade and the repositories touch it.
 */
export class Storage {
  readonly directory: string;
  readonly database: DatabaseSync;

  private constructor(directory: string, database: DatabaseSync) {
    this.directory = directory;
    this.database = database;
  }

  /** Create or open `<dataDir>/dashboard.sqlite` (private file) and migrate it. */
  static async open(dataDir = dashboardDataDirectory()): Promise<Storage> {
    const directory = resolve(dataDir);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, "dashboard.sqlite");
    try {
      await writeFile(file, "", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    if (!(await lstat(file)).isFile())
      throw new Error("Dashboard database must be a regular file.");
    await chmod(file, 0o600);
    // Load SQLite only for serve; ordinary CLI scans keep their current startup behavior.
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(file, { timeout: 5000 });
    const storage = new Storage(directory, database);
    try {
      database.exec(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON;",
      );
      storage.transaction(() => migrate(database));
      return storage;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  /** Run `write` atomically; a throw rolls everything back and propagates. */
  transaction<T>(write: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = write();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Every per-project table references `projects`; register the path before writing to them. */
  ensureProject(path: string): void {
    this.database
      .prepare("INSERT INTO projects (path) VALUES (?) ON CONFLICT DO NOTHING")
      .run(path);
  }

  close(): void {
    this.database.close();
  }
}
