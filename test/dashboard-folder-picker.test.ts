import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardSession, FolderListing } from "../src/dashboard/model.ts";
import { startDashboard } from "../src/dashboard/server.ts";

describe("dashboard system folder picker", () => {
  let root: string;
  let dashboard: Awaited<ReturnType<typeof startDashboard>>;
  let session: DashboardSession;
  const folderPicker = vi.fn<(path: string, signal: AbortSignal) => Promise<string | null>>();

  function choose(body: unknown = { path: root }, options: RequestInit = {}) {
    return fetch(`${dashboard.url}/api/folders/choose`, {
      method: "POST",
      body: JSON.stringify(body),
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-Plenger-Token": session.token,
        ...options.headers,
      },
    });
  }

  async function state() {
    return (
      await fetch(`${dashboard.url}/api/state`, {
        headers: { "X-Plenger-Token": session.token },
      })
    ).json();
  }

  beforeEach(async () => {
    folderPicker.mockReset();
    root = await realpath(await mkdtemp(join(tmpdir(), "plenger-folder-picker-")));
    await mkdir(join(root, "assets"));
    await mkdir(join(root, "selected"));
    await writeFile(join(root, "assets", "index.html"), "<html>Dashboard</html>");
    dashboard = await startDashboard({
      workspace: root,
      assets: join(root, "assets"),
      dataDir: join(root, ".dashboard-data"),
      folderPicker,
    });
    session = (await (await fetch(`${dashboard.url}/api/session`)).json()) as DashboardSession;
  });

  afterEach(async () => {
    await dashboard?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("opens the system picker and returns the chosen folder to the dashboard", async () => {
    folderPicker.mockResolvedValue(join(root, "selected"));
    const saved = await state();
    const response = await choose();
    expect(response.status).toBe(200);
    const result = (await response.json()) as { folder: FolderListing };
    expect(result.folder.path).toBe(join(root, "selected"));
    expect(folderPicker).toHaveBeenCalledWith(root, expect.any(AbortSignal));
    expect(await state()).toEqual(saved);
  });

  it("treats cancellation as an empty selection and preserves saved project data", async () => {
    folderPicker.mockResolvedValue(null);
    const saved = await state();
    const response = await choose();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ folder: null });
    expect(await state()).toEqual(saved);
  });

  it("rejects invalid or foreign requests before opening a native dialog", async () => {
    expect((await choose(undefined, { headers: { "X-Plenger-Token": "" } })).status).toBe(403);
    expect((await choose(undefined, { headers: { Origin: "https://evil.example" } })).status).toBe(
      403,
    );
    const get = await fetch(`${dashboard.url}/api/folders/choose`, {
      headers: { "X-Plenger-Token": session.token },
    });
    expect(get.status).toBe(405);
    expect((await choose(undefined, { headers: { "Content-Type": "text/plain" } })).status).toBe(
      415,
    );
    for (const body of [
      {},
      { path: 42 },
      { path: root, command: "anything" },
      { path: "missing" },
      { path: "\0" },
    ]) {
      expect((await choose(body)).status).toBe(400);
    }
    expect(folderPicker).not.toHaveBeenCalled();
  });

  it("validates the chosen folder before returning it to the dashboard", async () => {
    folderPicker.mockResolvedValue(join(root, "assets", "index.html"));
    const response = await choose();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Choose an existing project folder." });
  });

  it("keeps the in-app browser available after a native helper fails", async () => {
    folderPicker.mockRejectedValueOnce(new Error("private native process stderr"));
    const response = await choose();
    expect(response.status).toBe(503);
    const failure = await response.text();
    expect(failure).toContain("Browse the folders below");
    expect(failure).not.toContain("private native process stderr");
    const manual = await fetch(`${dashboard.url}/api/folders`, {
      headers: { "X-Plenger-Token": session.token },
    });
    expect(manual.status).toBe(200);
    folderPicker.mockResolvedValue(null);
    expect((await choose()).status).toBe(200);
  });

  it("allows only one native dialog at a time and releases the picker after cancellation", async () => {
    const opened = Promise.withResolvers<void>();
    const selection = Promise.withResolvers<string | null>();
    folderPicker.mockImplementationOnce(() => {
      opened.resolve();
      return selection.promise;
    });
    const pending = choose();
    try {
      await opened.promise;
      expect((await choose()).status).toBe(409);
      expect(folderPicker).toHaveBeenCalledTimes(1);
    } finally {
      selection.resolve(null);
      await pending;
    }
    folderPicker.mockResolvedValue(null);
    expect((await choose()).status).toBe(200);
  });

  it("keeps one dialog active after a browser disconnect until the native picker finishes", async () => {
    const opened = Promise.withResolvers<void>();
    const selection = Promise.withResolvers<string | null>();
    folderPicker.mockImplementationOnce(() => {
      opened.resolve();
      return selection.promise;
    });
    const client = new AbortController();
    const pending = choose(undefined, { signal: client.signal }).catch(() => null);
    try {
      await opened.promise;
      client.abort();
      await pending;
      expect((await choose()).status).toBe(409);
      expect(folderPicker).toHaveBeenCalledTimes(1);
    } finally {
      client.abort();
      selection.resolve(null);
      await pending;
    }
    folderPicker.mockResolvedValue(null);
    expect((await choose()).status).toBe(200);
  });

  it("cancels an open native picker when the dashboard shuts down", async () => {
    const opened = Promise.withResolvers<AbortSignal>();
    folderPicker.mockImplementationOnce(
      (_path, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
          opened.resolve(signal);
        }),
    );
    const pending = choose().catch(() => null);
    const signal = await opened.promise;
    await dashboard.close();
    expect(signal.aborted).toBe(true);
    await pending;
  });
});
