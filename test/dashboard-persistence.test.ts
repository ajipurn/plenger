import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardScan, DashboardState } from "../src/dashboard/contract.ts";
import type { ProjectPlan } from "../src/redteam/plan.ts";
import * as scanner from "../src/scan.ts";
import { SCHEMA_VERSION } from "../src/storage/migrations.ts";
import { startTestDashboard, type TestDashboard } from "./support/dashboard.ts";
import { fixturePath } from "./support/fixtures.ts";
import { temporaryDir } from "./support/tmp.ts";

const fixture = fixturePath("mixed-agent");
const llmfy = fixturePath("redteam/llmfy");
const risks = fixturePath("risks");
let root: string;
let dataDir: string;
let dashboard: TestDashboard;

async function start(workspace?: string) {
  dashboard = await startTestDashboard({ root, ...(workspace === undefined ? {} : { workspace }) });
}
const request: TestDashboard["request"] = (...args) => dashboard.request(...args);
const state = () => dashboard.state();
async function scan(path: string) {
  const response = await request("/api/scan", { path });
  expect(response.status).toBe(200);
  return (await response.json()) as DashboardScan;
}

describe("SQLite dashboard persistence", () => {
  beforeEach(async () => {
    root = await temporaryDir("plenger-persistence-");
    dataDir = join(root, "data");
    await start(fixture);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await dashboard.close();
  });

  it("persists the global theme across projects and service restarts and serves it before JavaScript loads", async () => {
    expect((await state()).theme).toBe("dark");
    expect(await (await request("/api/theme", { theme: "light" })).json()).toEqual({
      theme: "light",
    });
    await request("/api/project", { path: llmfy });
    expect((await state()).theme).toBe("light");
    await dashboard.close();
    await start();
    expect((await state()).theme).toBe("light");
    for (const path of ["/", "/redteam"]) {
      const response = await fetch(`${dashboard.url}${path}`);
      const html = await response.text();
      expect(html).toContain('data-theme="light"');
      expect(html).not.toContain('data-theme="dark"');
      expect(html).toContain('name="color-scheme" content="light"');
      expect(html).toContain('name="theme-color" content="#f1f6f4"');
      expect(response.headers.get("content-security-policy")).toContain("script-src 'self';");
    }
    await request("/api/theme", { theme: "dark" });
    await dashboard.close();
    await start(fixture);
    expect((await state()).theme).toBe("dark");
    expect(await (await fetch(dashboard.url)).text()).toContain('data-theme="dark"');
  });

  it("upgrades the previous database without losing saved scans or plans", async () => {
    await scan(llmfy);
    await request("/api/plan", { path: llmfy });
    const saved = await state();
    await dashboard.close();
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(join(dataDir, "dashboard.sqlite"));
    database.exec("DROP TABLE preferences; PRAGMA user_version = 1;");
    database.close();
    await start();
    expect(await state()).toEqual(saved);
    const upgraded = new DatabaseSync(join(dataDir, "dashboard.sqlite"));
    try {
      expect(upgraded.prepare("PRAGMA user_version").get()?.user_version).toBe(SCHEMA_VERSION);
    } finally {
      upgraded.close();
    }
    expect((await request("/api/theme", { theme: "light" })).status).toBe(200);
  });

  it("upgrades a first-release database that has only the original three tables", async () => {
    await dashboard.close();
    await rm(dataDir, { recursive: true, force: true });
    await mkdir(dataDir, { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const legacy = new DatabaseSync(join(dataDir, "dashboard.sqlite"));
    legacy.exec(`
      CREATE TABLE projects (path TEXT PRIMARY KEY, scan_id TEXT REFERENCES scans(id) ON DELETE SET NULL, plan TEXT) STRICT;
      CREATE TABLE scans (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project TEXT NOT NULL REFERENCES projects(path) ON DELETE CASCADE, created_at TEXT NOT NULL, findings INTEGER NOT NULL, files INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
      CREATE TABLE workspace (id INTEGER PRIMARY KEY CHECK (id = 1), project TEXT NOT NULL REFERENCES projects(path) ON DELETE CASCADE) STRICT;
      INSERT INTO projects (path) VALUES ('/legacy');
      INSERT INTO workspace (id, project) VALUES (1, '/legacy');
      PRAGMA user_version = 1;
    `);
    legacy.close();
    await start();
    expect(await state()).toMatchObject({
      project: "/legacy",
      theme: "dark",
      runs: [],
      campaigns: [],
      runProfile: null,
    });
    expect(await (await request("/api/providers")).json()).toEqual([]);
    const upgraded = new DatabaseSync(join(dataDir, "dashboard.sqlite"));
    try {
      expect(upgraded.prepare("PRAGMA user_version").get()?.user_version).toBe(SCHEMA_VERSION);
      const tables = upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name);
      expect(tables).toEqual([
        "model_pricing_catalog",
        "model_providers",
        "model_window_catalog",
        "preferences",
        "projects",
        "provider_model_catalogs",
        "rea_evidence",
        "redteam_campaigns",
        "redteam_profiles",
        "redteam_runs",
        "scans",
        "security_findings",
        "security_repositories",
        "security_reviews",
        "security_scans",
        "sqlite_sequence",
        "workspace",
      ]);
    } finally {
      upgraded.close();
    }
  });

  it("refuses a database written by a newer Plenger instead of guessing its schema", async () => {
    await dashboard.close();
    const { DatabaseSync } = await import("node:sqlite");
    const future = new DatabaseSync(join(dataDir, "dashboard.sqlite"));
    future.exec("PRAGMA user_version = 99");
    future.close();
    await expect(start()).rejects.toThrow("version is unsupported");
    const restored = new DatabaseSync(join(dataDir, "dashboard.sqlite"));
    restored.exec("PRAGMA user_version = 5");
    restored.close();
    await start();
  });

  it("validates and authenticates theme changes without replacing the last saved preference", async () => {
    await request("/api/theme", { theme: "light" });
    expect((await request("/api/theme", { theme: "dark" }, { "X-Plenger-Token": "" })).status).toBe(
      403,
    );
    expect(
      (await request("/api/theme", { theme: "dark" }, { Origin: "https://evil.example" })).status,
    ).toBe(403);
    expect((await request("/api/theme")).status).toBe(405);
    for (const body of [
      null,
      [],
      {},
      { theme: "auto" },
      { theme: 2 },
      { theme: "dark", extra: true },
    ])
      expect((await request("/api/theme", body)).status).toBe(400);
    expect(
      (await request("/api/theme", { theme: "dark" }, { "Content-Type": "text/plain" })).status,
    ).toBe(415);
    expect((await state()).theme).toBe("light");
  });

  it("serves the system theme with a colour scheme and theme colour for each device setting", async () => {
    expect(await (await request("/api/theme", { theme: "system" })).json()).toEqual({
      theme: "system",
    });
    await dashboard.close();
    await start();
    expect((await state()).theme).toBe("system");
    const html = await (await fetch(dashboard.url)).text();
    expect(html).toContain('data-theme="system"');
    expect(html).toContain('name="color-scheme" content="light dark"');
    expect(html).toContain(
      '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#172b36" />',
    );
    expect(html).toContain(
      '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f1f6f4" />',
    );
  });

  it("persists the density and serves it before JavaScript loads", async () => {
    expect((await state()).density).toBe("comfortable");
    expect(await (await request("/api/density", { density: "compact" })).json()).toEqual({
      density: "compact",
    });
    for (const body of [{}, { density: "dense" }, { density: "compact", extra: true }])
      expect((await request("/api/density", body)).status).toBe(400);
    await dashboard.close();
    await start();
    expect((await state()).density).toBe("compact");
    const session = await (await request("/api/session")).json();
    expect(session).toMatchObject({ density: "compact" });
    expect(await (await fetch(dashboard.url)).text()).toContain('data-density="compact"');
  });

  it("adds the density to an existing preferences row without changing its theme", async () => {
    await request("/api/theme", { theme: "system" });
    await dashboard.close();
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(join(dataDir, "dashboard.sqlite"));
    database.exec(`
      DROP TABLE preferences;
      CREATE TABLE preferences (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        theme TEXT NOT NULL CHECK (theme IN ('dark', 'system', 'light'))
      ) STRICT;
      INSERT INTO preferences (id, theme) VALUES (1, 'system');
      PRAGMA user_version = 12;
    `);
    database.close();
    await start();
    expect(await state()).toMatchObject({ theme: "system", density: "comfortable" });
    expect((await request("/api/density", { density: "compact" })).status).toBe(200);
    expect((await state()).density).toBe("compact");
  });

  it("keeps the saved theme when the preferences table learns the system theme", async () => {
    await request("/api/theme", { theme: "light" });
    await dashboard.close();
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(join(dataDir, "dashboard.sqlite"));
    database.exec(`
      DROP TABLE preferences;
      CREATE TABLE preferences (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        theme TEXT NOT NULL CHECK (theme IN ('dark', 'light'))
      ) STRICT;
      INSERT INTO preferences (id, theme) VALUES (1, 'light');
      PRAGMA user_version = 11;
    `);
    database.close();
    await start();
    expect((await state()).theme).toBe("light");
    expect((await request("/api/theme", { theme: "system" })).status).toBe(200);
    expect((await state()).theme).toBe("system");
  });

  it("restores scan snapshots, selected history, project selection and target plans after restart", async () => {
    const first = await scan(fixture);
    const second = await scan(fixture);
    const third = await scan(llmfy);
    const planned = (await (await request("/api/plan", { path: llmfy })).json()) as ProjectPlan;
    const target = planned.targets.find((target) => target.kind === "function")?.id;
    expect(target).toBeDefined();
    const plan = (await (
      await request("/api/plan", { path: llmfy, target })
    ).json()) as ProjectPlan;
    const before = await state();
    expect(before.report).toEqual(third);
    expect(before.plan).toEqual(plan);
    expect(before.history.map((scan) => scan.id)).toEqual([third.id, second.id, first.id]);
    await dashboard.close();
    await start();
    expect(await state()).toEqual(before);
    const reopened = await request("/api/history/open", { id: first.id });
    expect(reopened.status).toBe(200);
    expect(((await reopened.json()) as DashboardState).report).toEqual(first);
    await dashboard.close();
    await start();
    expect((await state()).report).toEqual(first);
    const other = (await (await request("/api/project", { path: llmfy })).json()) as DashboardState;
    expect(other.report).toEqual(third);
    expect(other.plan).toEqual(plan);
    await dashboard.close();
    await start();
    expect((await state()).project).toBe(await realpath(llmfy));
    // An explicit startup folder takes precedence over the last selected project.
    await dashboard.close();
    await start(fixture);
    expect((await state()).report).toEqual(first);
    expect((await state()).plan).toBeNull();
    expect((await readFile(join(dataDir, "dashboard.sqlite"))).subarray(0, 16).toString()).toBe(
      "SQLite format 3\0",
    );
    if (process.platform !== "win32") {
      expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dataDir, "dashboard.sqlite"))).mode & 0o777).toBe(0o600);
    }
  });

  it("clears all saved data, stays empty after restart, and can save again without altering project files", async () => {
    // Use a real fixture file without assuming a particular project layout.
    const scanned = await scan(llmfy);
    const file = join(llmfy, scanned.scan.files[0]?.path ?? "agent.py");
    const original = await readFile(file);
    await request("/api/plan", { path: llmfy });
    await request("/api/theme", { theme: "light" });
    const cleared = await request("/api/state/clear", {});
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      report: null,
      plan: null,
      history: [],
      project: await realpath(fixture),
      theme: "light",
    });
    expect(await readFile(file)).toEqual(original);
    await dashboard.close();
    await start();
    expect(await state()).toMatchObject({ report: null, plan: null, history: [], theme: "light" });
    const next = await scan(fixture);
    expect((await state()).history.map((item) => item.id)).toEqual([next.id]);
  });

  it("protects saved state and clearing with the same token, origin and request checks", async () => {
    const saved = await scan(fixture);
    expect((await request("/api/state", undefined, { "X-Plenger-Token": "wrong" })).status).toBe(
      403,
    );
    expect((await request("/api/state/clear", {}, { "X-Plenger-Token": "" })).status).toBe(403);
    expect((await request("/api/state/clear", {}, { Origin: "https://evil.example" })).status).toBe(
      403,
    );
    expect((await request("/api/state/clear")).status).toBe(405);
    expect((await request("/api/state/clear", { path: fixture })).status).toBe(400);
    expect((await request("/api/history/open", { id: "not-a-saved-scan" })).status).toBe(404);
    expect((await request("/api/history/open", { id: saved.id, extra: true })).status).toBe(400);
    expect((await state()).report).toEqual(saved);
  });

  it("keeps committed results when scans fail and refuses clear or selection during a scan", async () => {
    const saved = await scan(fixture);
    const running = Promise.withResolvers<void>();
    const result = Promise.withResolvers<scanner.ScanResult>();
    vi.spyOn(scanner, "scan").mockImplementationOnce(() => {
      running.resolve();
      return result.promise;
    });
    const pending = request("/api/scan", { path: fixture });
    await running.promise;
    expect((await request("/api/theme", { theme: "light" })).status).toBe(200);
    expect((await state()).theme).toBe("light");
    expect((await request("/api/state/clear", {})).status).toBe(409);
    expect((await request("/api/project", { path: llmfy })).status).toBe(409);
    expect((await request("/api/history/open", { id: saved.id })).status).toBe(409);
    expect((await state()).report).toEqual(saved);
    result.reject(new Error("Scan failed"));
    expect((await pending).status).toBe(500);
    expect((await state()).report).toEqual(saved);
    expect((await request("/api/state/clear", {})).status).toBe(200);
  });

  it("stores only the scanner's redacted payload", async () => {
    await scan(risks);
    const body = JSON.stringify(await state());
    expect(body).toContain("<redacted>");
    expect(body).not.toContain("sk-proj-Zq8vN2kT5wR9mL3xB7cJ1pF4");
    expect(body).not.toContain("AKIAZ7Q3W9R2T5Y8U1P4");
    await dashboard.close();
    await start();
    expect(JSON.stringify(await state())).toBe(body);
  });

  it("retains more than 20 scans while returning only history summaries", async () => {
    const first = await scan(fixture);
    vi.spyOn(scanner, "scan").mockResolvedValue(first.scan);
    let latest = first;
    for (let index = 0; index < 20; index++) latest = await scan(fixture);
    const saved = await state();
    expect(saved.history).toHaveLength(21);
    expect(saved.history.at(-1)?.id).toBe(first.id);
    expect(saved.history[0]?.id).toBe(latest.id);
    expect(saved.history.every((item) => !("scan" in item) && !("rules" in item))).toBe(true);
    await dashboard.close();
    await start();
    expect((await state()).history).toEqual(saved.history);
  });

  it("rolls back project selection and history if SQLite cannot save a completed scan", async () => {
    await scan(fixture);
    const saved = await state();
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(join(dataDir, "dashboard.sqlite"));
    try {
      database.exec(`
        CREATE TRIGGER reject_scan BEFORE INSERT ON scans
        BEGIN SELECT RAISE(ABORT, 'Simulated storage failure'); END;
      `);
      expect((await request("/api/scan", { path: llmfy })).status).toBe(500);
      expect(await state()).toEqual(saved);
      database.exec("DROP TRIGGER reject_scan");
    } finally {
      database.close();
    }
    const next = await scan(llmfy);
    expect((await state()).report).toEqual(next);
  });

  it("finishes saving an in-flight scan before closing SQLite during shutdown", async () => {
    const first = await scan(fixture);
    const running = Promise.withResolvers<void>();
    const result = Promise.withResolvers<scanner.ScanResult>();
    vi.spyOn(scanner, "scan").mockImplementationOnce(() => {
      running.resolve();
      return result.promise;
    });
    // Shutdown closes the HTTP connection but must still commit the finished operation.
    const pending = request("/api/scan", { path: fixture }).catch(() => null);
    await running.promise;
    const closing = dashboard.close();
    result.resolve(first.scan);
    await closing;
    await pending;
    await start();
    const restored = await state();
    expect(restored.history).toHaveLength(2);
    expect(restored.report?.id).not.toBe(first.id);
    expect(restored.report?.scan).toEqual(first.scan);
  });
});
