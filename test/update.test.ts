import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createUpdates, type UpdateOptions } from "../src/cli/update.ts";
import { captureCli } from "./support/cli.ts";
import { temporaryDir } from "./support/tmp.ts";

async function harness(overrides: UpdateOptions = {}) {
  const root = await temporaryDir("plenger-update-");
  const prefix = join(root, "prefix");
  const globalRoot = join(prefix, "lib", "node_modules");
  const installation = join(globalRoot, "plenger");
  const dataDirectory = join(root, "data");
  await mkdir(installation, { recursive: true });
  const manifest = join(installation, "package.json");
  await writeFile(manifest, JSON.stringify({ name: "plenger", version: "0.1.0" }));
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ name: "plenger", version: "0.2.0" }),
  );
  const confirm = vi.fn(async () => true);
  const npm = vi.fn(async (args: string[]) => {
    if (args[0] === "root") return globalRoot;
    if (args[0] === "prefix") return prefix;
    await writeFile(manifest, JSON.stringify({ name: "plenger", version: "0.2.0" }));
    return "";
  });
  let time = 1_800_000_000_000;
  const service = createUpdates({
    privateBuild: false,
    disabled: false,
    interactive: true,
    version: "0.1.0",
    packageDirectory: installation,
    dataDirectory,
    fetch,
    confirm,
    npm,
    now: () => time,
    ...overrides,
  });
  return {
    root,
    installation,
    prefix,
    globalRoot,
    dataDirectory,
    manifest,
    fetch,
    confirm,
    npm,
    service,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}

async function notification(
  service: ReturnType<typeof createUpdates>,
  signal = new AbortController().signal,
) {
  let output = "";
  await service.notify(
    {
      stdout: (text) => {
        output += text;
      },
    },
    signal,
  );
  return output;
}

describe("background update checks", () => {
  it("checks once per day, reuses cached notices and never installs a package", async () => {
    const h = await harness();
    expect(await notification(h.service)).toContain("0.2.0 is available");
    expect(h.fetch).toHaveBeenCalledWith(
      "https://registry.npmjs.org/plenger/latest",
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
    );
    expect(await notification(h.service)).toContain("Run plenger update");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.advance(24 * 60 * 60 * 1000);
    await notification(h.service);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.npm).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(
      JSON.parse(await readFile(join(h.dataDirectory, "update-check.json"), "utf8")),
    ).toMatchObject({ version: "0.2.0" });
  });

  it.each([{ privateBuild: true }, { disabled: true }])("skips checks for %j", async (options) => {
    const h = await harness(options);
    expect(await notification(h.service)).toBe("");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("keeps offline and missing releases quiet and caches a missing release", async () => {
    const h = await harness();
    h.fetch.mockRejectedValueOnce(new Error("private network details"));
    expect(await notification(h.service)).toBe("");
    h.fetch.mockResolvedValue(new Response(null, { status: 404 }));
    expect(await notification(h.service)).toBe("");
    expect(await notification(h.service)).toBe("");
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "other-package", version: "0.2.0" },
    { name: "plenger", version: "0.2.0; echo private" },
    { name: "plenger", version: "0.2.0-beta.1" },
    { name: "plenger", version: "9007199254740992.0.0" },
  ])("ignores invalid release metadata: %j", async (metadata) => {
    const h = await harness();
    h.fetch.mockResolvedValue(Response.json(metadata));
    expect(await notification(h.service)).toBe("");
    expect(h.npm).not.toHaveBeenCalled();
  });

  it("does not notify for equal or older versions and compares version components numerically", async () => {
    const equal = await harness({ version: "0.2.0" });
    expect(await notification(equal.service)).toBe("");
    const older = await harness({ version: "1.0.0" });
    expect(await notification(older.service)).toBe("");
    const numeric = await harness({ version: "0.9.0" });
    numeric.fetch.mockResolvedValue(Response.json({ name: "plenger", version: "0.10.0" }));
    expect(await notification(numeric.service)).toContain("0.10.0 is available");
  });

  it("stops an in-flight check on dashboard shutdown without a late notice", async () => {
    const h = await harness();
    h.fetch.mockImplementation(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const controller = new AbortController();
    const pending = notification(h.service, controller.signal);
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledOnce());
    controller.abort();
    expect(await pending).toBe("");
  });

  it("refreshes malformed and future-dated cache entries", async () => {
    const h = await harness();
    await mkdir(h.dataDirectory);
    const cache = join(h.dataDirectory, "update-check.json");
    for (const content of [
      "not json",
      JSON.stringify({ name: "plenger", version: "9.0.0", checkedAt: Number.MAX_SAFE_INTEGER }),
    ]) {
      await writeFile(cache, content);
      expect(await notification(h.service)).toContain("0.2.0 is available");
    }
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("confirmed npm updates", () => {
  it("installs only the confirmed version into the matching global prefix and verifies it", async () => {
    const h = await harness();
    const result = await captureCli(["update"], h.service);
    expect(result.code).toBe(0);
    expect(h.confirm).toHaveBeenCalledWith(expect.stringContaining("0.1.0 to 0.2.0"));
    expect(h.npm.mock.calls[2]?.[0]).toEqual([
      "install",
      "--global",
      "--prefix",
      h.prefix,
      "plenger@0.2.0",
      "--ignore-scripts",
      "--engine-strict",
      "--registry=https://registry.npmjs.org",
    ]);
    expect(result.stdout).toContain("Updated to Plenger 0.2.0");
    expect(result.stderr).toBe("");
    // An update before first launch must not create a data folder and prevent legacy migration.
    await expect(stat(h.dataDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels without installing when confirmation is declined", async () => {
    const h = await harness();
    h.confirm.mockResolvedValue(false);
    const result = await captureCli(["update"], h.service);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Update cancelled");
    expect(h.npm).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(h.manifest, "utf8")).version).toBe("0.1.0");
  });

  it("refuses non-interactive updates without an implicit yes", async () => {
    const h = await harness({ interactive: false });
    expect((await captureCli(["update"], h.service)).code).toBe(2);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.npm).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite local, npx or linked development installations", async () => {
    const directory = await temporaryDir();
    const local = await harness({ packageDirectory: directory });
    expect((await captureCli(["update"], local.service)).code).toBe(2);
    expect(local.fetch).not.toHaveBeenCalled();
    const linked = await harness();
    const checkout = join(linked.root, "checkout");
    await mkdir(checkout);
    await rm(linked.installation, { recursive: true });
    await symlink(checkout, linked.installation, process.platform === "win32" ? "junction" : "dir");
    expect((await captureCli(["update"], linked.service)).code).toBe(2);
    expect(linked.confirm).not.toHaveBeenCalled();
  });

  it("does not query npm for private builds", async () => {
    const h = await harness({ privateBuild: true });
    expect((await captureCli(["update"], h.service)).stderr).toContain("private build");
    expect(h.npm).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("does not prompt when already current and never downgrades", async () => {
    const h = await harness({ version: "0.3.0" });
    const result = await captureCli(["update"], h.service);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("up to date");
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.npm).toHaveBeenCalledTimes(2);
  });

  it("uses fresh registry metadata even when a startup check was cached", async () => {
    const h = await harness();
    await notification(h.service);
    h.fetch.mockResolvedValue(Response.json({ name: "plenger", version: "0.1.0" }));
    expect((await captureCli(["update"], h.service)).stdout).toContain("up to date");
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("reports missing releases, failed installs and unverified results as failures", async () => {
    const missing = await harness();
    missing.fetch.mockResolvedValue(new Response(null, { status: 404 }));
    expect((await captureCli(["update"], missing.service)).code).toBe(1);
    expect(missing.confirm).not.toHaveBeenCalled();
    const failed = await harness();
    failed.npm.mockImplementation(async (args) => {
      if (args[0] === "root") return failed.globalRoot;
      if (args[0] === "prefix") return failed.prefix;
      throw new Error("npm failed");
    });
    expect((await captureCli(["update"], failed.service)).code).toBe(1);
    const unverified = await harness();
    unverified.npm.mockImplementation(async (args) =>
      args[0] === "root" ? unverified.globalRoot : args[0] === "prefix" ? unverified.prefix : "",
    );
    expect((await captureCli(["update"], unverified.service)).code).toBe(1);
  });
});
