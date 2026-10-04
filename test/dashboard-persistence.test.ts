import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardScan, DashboardSession, DashboardState } from "../src/dashboard/model.ts";
import { startDashboard } from "../src/dashboard/server.ts";
import type { ProjectPlan } from "../src/redteam/plan.ts";
import * as scanner from "../src/scan.ts";

const fixture = fileURLToPath(new URL("fixtures/mixed-agent", import.meta.url));
const llmfy = fileURLToPath(new URL("fixtures/redteam/llmfy", import.meta.url));
const risks = fileURLToPath(new URL("fixtures/risks", import.meta.url));
let root: string;
let assets: string;
let dataDir: string;
let dashboard: Awaited<ReturnType<typeof startDashboard>>;
let session: DashboardSession;

async function start(workspace?: string) {
  dashboard = await startDashboard({
    assets,
    dataDir,
    ...(workspace === undefined ? {} : { workspace }),
  });
  session = (await (await fetch(`${dashboard.url}/api/session`)).json()) as DashboardSession;
}
function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${dashboard.url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Plenger-Token": session.token, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function state() {
  return (await (await request("/api/state")).json()) as DashboardState;
}
async function scan(path: string) {
  const response = await request("/api/scan", { path });
  expect(response.status).toBe(200);
  return (await response.json()) as DashboardScan;
}

describe("SQLite dashboard persistence", () => {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "plenger-persistence-")));
    assets = join(root, "assets");
    dataDir = join(root, "data");
    await mkdir(assets);
    await writeFile(
      join(assets, "index.html"),
      '<html lang="en" data-theme="dark"><head><meta name="color-scheme" content="dark"><meta name="theme-color" content="#0b0b0b"></head><body>Dashboard</body></html>',
    );
    await start(fixture);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
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
      expect(html).toContain('name="theme-color" content="#fafafa"');
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
      expect(upgraded.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    } finally {
      upgraded.close();
    }
    expect((await request("/api/theme", { theme: "light" })).status).toBe(200);
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
      { theme: "system" },
      { theme: 2 },
      { theme: "dark", extra: true },
    ])
      expect((await request("/api/theme", body)).status).toBe(400);
    expect(
      (await request("/api/theme", { theme: "dark" }, { "Content-Type": "text/plain" })).status,
    ).toBe(415);
    expect((await state()).theme).toBe("light");
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
    let rejectScan!: (error: Error) => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(scanner, "scan").mockImplementationOnce(() => {
      started();
      return new Promise((_resolve, reject) => {
        rejectScan = reject;
      });
    });
    const pending = request("/api/scan", { path: fixture });
    await running;
    expect((await request("/api/theme", { theme: "light" })).status).toBe(200);
    expect((await state()).theme).toBe("light");
    expect((await request("/api/state/clear", {})).status).toBe(409);
    expect((await request("/api/project", { path: llmfy })).status).toBe(409);
    expect((await request("/api/history/open", { id: saved.id })).status).toBe(409);
    expect((await state()).report).toEqual(saved);
    rejectScan(new Error("Scan failed"));
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
