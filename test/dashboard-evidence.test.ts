import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API,
  type DashboardScan,
  type ImportedReaEvidence,
  REA_LIMITS,
  TOKEN_HEADER,
} from "../src/dashboard/contract.ts";
import { SCHEMA_VERSION } from "../src/storage/migrations.ts";
import { required, startTestDashboard, type TestDashboard } from "./support/dashboard.ts";
import { fixturePath } from "./support/fixtures.ts";
import { reaEvidence } from "./support/rea.ts";
import { temporaryDir } from "./support/tmp.ts";

let dashboard: TestDashboard;
let root: string;
let report: DashboardScan;
const fixture = fixturePath("risks");
const runExecutor = vi.fn(async () => {
  throw new Error("No dynamic execution.");
});
async function start() {
  dashboard = await startTestDashboard({ root, workspace: fixture, runExecutor });
}
beforeEach(async () => {
  root = await temporaryDir("plenger-rea-api-");
  runExecutor.mockClear();
  await start();
  report = (await (await dashboard.request(API.scan, { path: fixture })).json()) as DashboardScan;
});
afterEach(async () => {
  await dashboard.close();
});
const list = (scanId = report.id) =>
  dashboard.request(`${API.reaEvidence}?scanId=${encodeURIComponent(scanId)}`);
async function importEvidence() {
  const response = await dashboard.request(API.reaEvidence, {
    scanId: report.id,
    filename: "electron.json",
    evidence: reaEvidence(),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ImportedReaEvidence;
}

describe("dashboard external evidence", () => {
  it("persists and deduplicates imports without altering scan findings or starting tools", async () => {
    const before = await dashboard.state();
    const saved = await importEvidence();
    expect(saved).toMatchObject({
      scanId: report.id,
      verification: "unverified",
      filename: "electron.json",
    });
    expect((await importEvidence()).id).toBe(saved.id);
    expect(await (await list()).json()).toEqual([saved]);
    expect(await dashboard.state()).toEqual(before);
    await dashboard.close();
    await start();
    expect(await (await list()).json()).toEqual([saved]);
    expect(runExecutor).not.toHaveBeenCalled();
  });

  it("keeps imports on their original scan and enforces deletion scope and clear-data cascade", async () => {
    const saved = await importEvidence();
    const second = (await (
      await dashboard.request(API.scan, { path: fixture })
    ).json()) as DashboardScan;
    expect(await (await list(second.id)).json()).toEqual([]);
    expect(
      (await dashboard.request(API.deleteReaEvidence, { scanId: second.id, id: saved.id })).status,
    ).toBe(404);
    expect(await (await list()).json()).toEqual([saved]);
    expect(
      (await dashboard.request(API.deleteReaEvidence, { scanId: report.id, id: saved.id })).status,
    ).toBe(200);
    expect(await (await list()).json()).toEqual([]);
    await importEvidence();
    await dashboard.request(API.clear, {});
    expect((await list()).status).toBe(404);
    await dashboard.close();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(root, "data/dashboard.sqlite"));
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM rea_evidence").get()?.count).toBe(0);
    } finally {
      db.close();
    }
    await start();
  });

  it("authenticates uploads and rejects paths, commands, wrong result types and oversized requests", async () => {
    const input = { scanId: report.id, filename: "rea.json", evidence: reaEvidence() };
    expect((await dashboard.request(API.reaEvidence, input, { [TOKEN_HEADER]: "" })).status).toBe(
      403,
    );
    expect(
      (await dashboard.request(API.reaEvidence, input, { Origin: "https://evil.example" })).status,
    ).toBe(403);
    for (const patch of [
      { scanId: "missing" },
      { filename: "../../rea.json" },
      { path: "/private/source" },
      { command: "rea setup" },
      { evidence: { operation: "capture_process_scenario" } },
    ]) {
      const response = await dashboard.request(API.reaEvidence, { ...input, ...patch });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    expect(
      (
        await dashboard.request(API.reaEvidence, {
          ...input,
          padding: "x".repeat(REA_LIMITS.requestBytes),
        })
      ).status,
    ).toBe(413);
    expect(await (await list()).json()).toEqual([]);
    expect(runExecutor).not.toHaveBeenCalled();
  });

  it("redacts source credentials before SQLite persistence and preserves the source file", async () => {
    const source = join(fixture, "js/tools.ts");
    const before = await readFile(source, "utf8");
    const evidence = reaEvidence();
    const secret = `sk-ant-api03-${"N7aQ2xP4".repeat(6)}`;
    required(
      required(evidence.normalized_result.graph.nodes[0], "node").observations[0],
      "observation",
    ).properties = {
      api_key: "opaque-secret-value",
      code: `key = '${secret}'`,
    };
    const response = await dashboard.request(API.reaEvidence, {
      scanId: report.id,
      filename: "rea.json",
      evidence,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(secret);
    await dashboard.close();
    const bytes = await readFile(join(root, "data/dashboard.sqlite"));
    expect(bytes.toString()).not.toContain(secret);
    expect(bytes.toString()).not.toContain("opaque-secret-value");
    expect(await readFile(source, "utf8")).toBe(before);
    await start();
  });

  it("upgrades a version-five store without losing its saved scan", async () => {
    const before = await dashboard.state();
    await dashboard.close();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(root, "data/dashboard.sqlite"));
    db.exec("DROP TABLE rea_evidence; PRAGMA user_version = 5;");
    db.close();
    await start();
    expect(await dashboard.state()).toEqual(before);
    await importEvidence();
    const upgraded = new DatabaseSync(join(root, "data/dashboard.sqlite"));
    try {
      expect(upgraded.prepare("PRAGMA user_version").get()?.user_version).toBe(SCHEMA_VERSION);
    } finally {
      upgraded.close();
    }
  });
});
