import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DashboardScan, FolderListing } from "../src/dashboard/contract.ts";
import { startDashboard } from "../src/dashboard/server.ts";
import type { ProjectPlan } from "../src/redteam/plan.ts";
import { RULES } from "../src/rules/index.ts";
import * as scanner from "../src/scan.ts";
import { startTestDashboard, type TestDashboard } from "./support/dashboard.ts";
import { fixturePath } from "./support/fixtures.ts";

const fixture = fixturePath("mixed-agent");
const risks = fixturePath("risks");
const llmfy = fixturePath("redteam/llmfy");
let root: string;
let dashboard: TestDashboard;

const api: TestDashboard["request"] = (...args) => dashboard.request(...args);

describe("local dashboard transport", () => {
  // One server for the whole file, so the temporary folder outlives each test.
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "plenger-dashboard-")));
    await mkdir(join(root, "visible"));
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "private.txt"), "outside asset root");
    await symlink(join(root, "visible"), join(root, "linked"));
    dashboard = await startTestDashboard({
      root,
      workspace: root,
      dataDir: join(root, ".dashboard-data"),
      html: "<html>Dashboard shell</html>",
    });
    await writeFile(join(root, "assets", "app.js"), "console.log('dashboard');");
    await symlink(join(root, "private.txt"), join(root, "assets", "leak.txt"));
    await symlink(root, join(root, "assets", "escape"));
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await dashboard?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("rejects unavailable dashboard assets before starting a server", async () => {
    await expect(
      startDashboard({ workspace: root, assets: join(root, "missing-assets") }),
    ).rejects.toThrow("Dashboard assets are unavailable");
  });

  it("binds a loopback session and refuses foreign origins, rebinding hosts and missing tokens", async () => {
    const { session } = dashboard;
    expect(dashboard.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(session.workspace).toBe(root);
    expect(session.token).toMatch(/^[a-f0-9]{64}$/);
    const missing = await fetch(`${dashboard.url}/api/folders`);
    expect(missing.status).toBe(403);
    expect((await api("/api/folders", undefined, { "X-Plenger-Token": "wrong" })).status).toBe(403);
    for (const endpoint of [
      "/api/session",
      "/api/folders",
      "/api/folders/choose",
      "/api/state",
      "/api/state/clear",
      "/api/theme",
      "/api/project",
      "/api/history/open",
      "/",
    ]) {
      const foreign = await fetch(`${dashboard.url}${endpoint}`, {
        headers: { Origin: "https://evil.example", "X-Plenger-Token": session.token },
      });
      expect(foreign.status).toBe(403);
      expect(foreign.headers.has("access-control-allow-origin")).toBe(false);
      const rebound = await rawStatus(endpoint, {
        Host: "localhost:12345",
        "X-Plenger-Token": session.token,
      });
      expect(rebound).toBe(403);
    }
    expect((await api("/api/folders", undefined, { Origin: dashboard.url })).status).toBe(200);
  });

  it("browses canonical folders without hidden directories, symlinks or files", async () => {
    const response = await api("/api/folders");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const listing = (await response.json()) as FolderListing;
    expect(listing.path).toBe(root);
    expect(listing.folders.map((folder) => folder.name)).toEqual(["assets", "visible"]);
    const relative = (await (await api("/api/folders?path=visible")).json()) as FolderListing;
    expect(relative.path).toBe(join(root, "visible"));
    expect(relative.parent).toBe(root);
    const invalid = await api("/api/folders?path=missing-secret-directory");
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("missing-secret-directory");
  });

  it("returns the same scan and rule catalog as the offline engine", async () => {
    const direct = await scanner.scan(fixture);
    const response = await api("/api/scan", { path: fixture });
    expect(response.status).toBe(200);
    const result = (await response.json()) as DashboardScan;
    expect(result.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(Number.isNaN(Date.parse(result.createdAt))).toBe(false);
    expect({ ...result.scan, durationMs: 0 }).toEqual({ ...direct, durationMs: 0 });
    expect(result.rules).toEqual(RULES);
  });

  it("keeps recognized credentials out of dashboard scan responses", async () => {
    const response = await api("/api/scan", { path: risks });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("<redacted>");
    expect(body).not.toContain("sk-proj-Zq8vN2kT5wR9mL3xB7cJ1pF4");
    expect(body).not.toContain("AKIAZ7Q3W9R2T5Y8U1P4");
    expect(body).not.toContain("Tr0ub4dor-x9Kq7mW2");
  });

  it("offers source preparation without making the target executable", async () => {
    const response = await api("/api/plan", { path: llmfy });
    expect(response.status).toBe(200);
    const plan = (await response.json()) as ProjectPlan;
    expect(plan.executionReady).toBe(false);
    expect(plan.mode).toBe("offline");
    expect(plan.selection).toBe("required");
    expect(plan.preparation.status).toBe("blocked");
    const selected = await api("/api/plan", {
      path: llmfy,
      target: plan.targets.find((target) => target.kind === "function")?.id,
    });
    expect(selected.status).toBe(200);
    const selectedPlan = (await selected.json()) as ProjectPlan;
    expect(selectedPlan.selection).toBe("explicit");
    expect(selectedPlan.preparation.status).toBe("ready");
    expect(selectedPlan.executionReady).toBe(false);
  });

  it("serializes expensive operations and clears busy status after a failure", async () => {
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<scanner.ScanResult>();
    const spy = vi.spyOn(scanner, "scan").mockImplementationOnce(() => {
      started.resolve();
      return result.promise;
    });
    const first = api("/api/scan", { path: fixture });
    await started.promise;
    expect((await api("/api/plan", { path: llmfy })).status).toBe(409);
    result.reject(new Error("private-path credential=do-not-repeat"));
    const failed = await first;
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("do-not-repeat");
    spy.mockRestore();
    expect((await api("/api/plan", { path: llmfy })).status).toBe(200);
  });

  it("rejects unsupported methods, content types, malformed bodies and oversized requests", async () => {
    expect((await api("/api/scan")).status).toBe(405);
    expect((await api("/api/folders", { path: root })).status).toBe(405);
    expect(
      (await api("/api/scan", { path: fixture }, { "Content-Type": "text/plain" })).status,
    ).toBe(415);
    for (const body of [
      null,
      [],
      {},
      { path: 2 },
      { path: fixture, execute: true },
      { path: "\0" },
    ])
      expect((await api("/api/scan", body)).status).toBe(400);
    expect((await api("/api/plan", { path: llmfy, target: "" })).status).toBe(400);
    expect((await api("/api/scan", { path: "x".repeat(9000) })).status).toBe(413);
    const malformed = await fetch(`${dashboard.url}/api/scan`, {
      method: "POST",
      headers: { "X-Plenger-Token": dashboard.session.token, "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect((await api("/api/scan", { path: join(root, "private.txt") })).status).toBe(400);
  });

  it("serves the built application with security headers and confines assets", async () => {
    const home = await fetch(dashboard.url);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Dashboard shell");
    expect(home.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(home.headers.get("x-content-type-options")).toBe("nosniff");
    expect(home.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    const asset = await fetch(`${dashboard.url}/app.js`);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect((await fetch(`${dashboard.url}/scans/current`)).status).toBe(200);
    for (const path of ["/leak.txt", "/escape/private.txt", "/missing.js"])
      expect((await fetch(`${dashboard.url}${path}`)).status).toBe(404);
    const traversal = await rawStatus("/%2e%2e/private.txt");
    expect(traversal).toBe(404);
    expect((await api("/api/not-here")).status).toBe(404);
  });

  it("binds stylesheet nonces to each HTML response without enabling inline scripts", async () => {
    const first = await fetch(dashboard.url);
    const html = await first.text();
    const nonce = /name="plenger-style-nonce" content="([A-Za-z0-9+/=]+)"/.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    const policy = first.headers.get("content-security-policy");
    expect(policy).toContain(`'nonce-${nonce}'`);
    expect(policy).toContain("script-src 'self';");
    expect(policy).not.toContain("'unsafe-inline'");
    const second = await fetch(`${dashboard.url}/findings`);
    expect(await second.text()).not.toContain(`content="${nonce}"`);
    expect(second.headers.get("content-security-policy")).not.toContain(`'nonce-${nonce}'`);
  });
});

async function rawStatus(path: string, headers: Record<string, string> = {}) {
  return new Promise<number | undefined>((resolveStatus, reject) => {
    const outgoing = request(`${dashboard.url}/`, { path, headers }, (response) => {
      response.resume();
      resolveStatus(response.statusCode);
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}
