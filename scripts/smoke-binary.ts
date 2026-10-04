import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { DashboardScan, DashboardSession, DashboardState } from "../src/dashboard/contract.ts";
import type { ProjectPlan } from "../src/redteam/plan.ts";
import type { Report } from "../src/report/model.ts";
import { launchDashboard } from "./lib/dashboard-smoke.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);
const filename = process.platform === "win32" ? "plenger.exe" : "plenger";
const source = resolve(process.argv[2] ?? join(root, "dist/binary", filename));
const environment: NodeJS.ProcessEnv = { PATH: "", NO_COLOR: "1" };
if (process.platform === "win32" && process.env.SystemRoot)
  environment.SystemRoot = process.env.SystemRoot;

async function main() {
  const version = (
    JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "plenger-binary-smoke-")));
  try {
    const runtime = join(temporary, "runtime");
    const fixture = join(temporary, "project");
    await mkdir(runtime);
    const binary = join(runtime, filename);
    await copyFile(source, binary);
    await chmod(binary, 0o755);
    await cp(join(root, "test/fixtures/mixed-agent"), fixture, { recursive: true });
    const run = async (args: string[]) =>
      execute(binary, args, {
        cwd: runtime,
        env: environment,
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      });
    assert.equal((await run(["--version"])).stdout.trim(), version);
    assert.match((await run(["--help"])).stdout, /plenger serve/);
    assert.match((await run(["redteam", "run", "--help"])).stdout, /--provider <name\|id>/);
    assert.match((await run(["redteam", "compare", "--help"])).stdout, /--change <text>/);
    const cli = await run(["scan", fixture, "--json"]);
    assert.equal(cli.stderr, "");
    const report = JSON.parse(cli.stdout) as Report;
    assert.equal(report.schemaVersion, 1);
    assert.deepEqual(report.tool, { name: "plenger", version });
    assert.equal(report.files.length, 6);
    for (const [path, language] of [
      ["app/main.py", "python"],
      ["web/legacy.cjs", "javascript"],
      ["web/agent.ts", "typescript"],
      ["web/Chat.tsx", "typescript"],
    ]) {
      const file = report.files.find((entry) => entry.path === path);
      assert.ok(file, `Missing parsed fixture ${path}`);
      assert.equal(file.language, language);
      assert.equal(file.syntaxErrors, false, `Fixture did not parse: ${path}`);
    }
    assert.equal(report.files.find((file) => file.path === "app/broken.py")?.syntaxErrors, true);
    console.log("Binary CLI passed with an empty PATH outside the checkout (Python, JS, TS, TSX).");

    const nextFixture = join(temporary, "next-project");
    await cp(join(root, "test/fixtures/redteam/vercel"), nextFixture, { recursive: true });
    const next = JSON.parse(
      (await run(["redteam", "plan", nextFixture, "--json"])).stdout,
    ) as ProjectPlan;
    assert.equal(next.nextProfile?.id, "vercel-booking-sqlite-v1");
    assert.equal(next.preparation.status, "ready");
    assert.equal(next.sources.policy, "next-route-sqlite-v1");
    assert.ok(next.sources.files.some((file) => file.path === "app/api/chat/route.ts"));
    console.log(
      "Binary managed Next.js planning passed outside the checkout without Node in PATH.",
    );

    const dataDir = join(temporary, "data");
    const server = await launchDashboard({
      program: binary,
      cwd: runtime,
      workspace: fixture,
      dataDir,
      env: environment,
    });
    let saved: DashboardScan;
    try {
      const { fetchPage } = server;
      const home = await fetchPage("/");
      assert.equal(home.status, 200);
      const html = await home.text();
      assert.match(html, /id="root"/);
      assert.match(html, /data-theme="dark"/);
      const nonce = /name="plenger-style-nonce" content="([A-Za-z0-9+/=]+)"/.exec(html)?.[1];
      assert.ok(nonce, "Dashboard HTML has no stylesheet nonce.");
      assert.ok(home.headers.get("content-security-policy")?.includes(`'nonce-${nonce}'`));
      const assetPaths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
        (match) => match[1],
      );
      assert.ok(
        assetPaths.some((path) => path?.endsWith(".js")),
        "Dashboard has no JS asset.",
      );
      assert.ok(
        assetPaths.some((path) => path?.endsWith(".css")),
        "Dashboard has no CSS asset.",
      );
      for (const path of assetPaths) {
        assert.ok(path);
        const asset = await fetchPage(path);
        assert.equal(asset.status, 200, `Embedded dashboard asset unavailable: ${path}`);
        assert.ok((await asset.arrayBuffer()).byteLength > 0);
      }
      const deepLink = await fetchPage("/findings");
      assert.equal(deepLink.status, 200);
      assert.match(await deepLink.text(), /id="root"/);
      assert.equal((await fetchPage("/missing.js")).status, 404);
      const sessionResponse = await fetchPage("/api/session");
      assert.equal(sessionResponse.status, 200);
      const session = (await sessionResponse.json()) as DashboardSession;
      assert.equal(session.workspace, await realpath(fixture));
      assert.match(session.token, /^[a-f0-9]{64}$/);
      assert.equal((await fetchPage("/api/folders")).status, 403);
      const scanned = await fetchPage("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Plenger-Token": session.token },
        body: JSON.stringify({ path: fixture }),
      });
      assert.equal(scanned.status, 200);
      const dashboard = (await scanned.json()) as DashboardScan;
      assert.deepEqual(dashboard.scan.files, report.files);
      assert.deepEqual(dashboard.scan.findings, report.findings);
      assert.ok(dashboard.rules.length > 0);
      saved = dashboard;
      const provider = await fetchPage("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Plenger-Token": session.token },
        body: JSON.stringify({
          name: "Binary smoke provider",
          provider: "openai",
          model: "smoke-model",
          baseUrl: "https://api.openai.com/v1",
          temperature: 0,
          maxOutputTokens: 512,
          isDefault: true,
          apiKey: "smoke-secret-do-not-export",
        }),
      });
      assert.equal(provider.status, 200);
      const providerText = await provider.text();
      assert.doesNotMatch(providerText, /smoke-secret-do-not-export/);
      assert.equal(JSON.parse(providerText).hasApiKey, true);
      const themed = await fetchPage("/api/theme", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Plenger-Token": session.token },
        body: JSON.stringify({ theme: "light" }),
      });
      assert.equal(themed.status, 200);
      assert.deepEqual(await themed.json(), { theme: "light" });
      assert.match(await (await fetchPage("/redteam")).text(), /data-theme="light"/);
      await server.stop();
    } finally {
      await server.dispose();
    }
    assert.equal(
      (await readFile(join(dataDir, "dashboard.sqlite"))).subarray(0, 16).toString(),
      "SQLite format 3\0",
    );
    assert.doesNotMatch(
      (await readFile(join(dataDir, "dashboard.sqlite"))).toString(),
      /smoke-secret-do-not-export/,
    );
    const resumed = await launchDashboard({
      program: binary,
      cwd: runtime,
      workspace: fixture,
      dataDir,
      env: environment,
    });
    try {
      const session = (await (await resumed.fetchPage("/api/session")).json()) as DashboardSession;
      const headers = { "X-Plenger-Token": session.token, "Content-Type": "application/json" };
      const state = (await (
        await resumed.fetchPage("/api/state", { headers })
      ).json()) as DashboardState;
      assert.deepEqual(state.report, saved);
      assert.equal(state.theme, "light");
      assert.deepEqual(state.campaigns, []);
      const providers = (await (await resumed.fetchPage("/api/providers", { headers })).json()) as {
        name: string;
        hasApiKey: boolean;
        isDefault: boolean;
      }[];
      assert.equal(providers[0]?.name, "Binary smoke provider");
      assert.equal(providers[0]?.hasApiKey, true);
      assert.equal(providers[0]?.isDefault, true);
      assert.match(await (await resumed.fetchPage("/findings")).text(), /data-theme="light"/);
      assert.deepEqual(
        state.history.map((item) => item.id),
        [saved.id],
      );
      const cleared = await resumed.fetchPage("/api/state/clear", {
        method: "POST",
        headers,
        body: "{}",
      });
      assert.equal(cleared.status, 200);
      const empty = (await cleared.json()) as DashboardState;
      assert.equal(empty.report, null);
      assert.equal(empty.plan, null);
      assert.deepEqual(empty.history, []);
      assert.deepEqual(empty.campaigns, []);
      assert.deepEqual(await (await resumed.fetchPage("/api/providers", { headers })).json(), []);
      assert.equal(empty.theme, "light");
      await resumed.stop();
    } finally {
      await resumed.dispose();
    }
    const cleared = await launchDashboard({
      program: binary,
      cwd: runtime,
      workspace: fixture,
      dataDir,
      env: environment,
    });
    try {
      const session = (await (await cleared.fetchPage("/api/session")).json()) as DashboardSession;
      const state = (await (
        await cleared.fetchPage("/api/state", {
          headers: { "X-Plenger-Token": session.token },
        })
      ).json()) as DashboardState;
      assert.equal(state.report, null);
      assert.deepEqual(state.history, []);
      assert.equal(state.theme, "light");
      await cleared.stop();
    } finally {
      await cleared.dispose();
    }
    console.log(
      `Binary dashboard passed: embedded assets, deep links, authenticated scan, saved theme, SQLite restart/clear, ${process.platform === "win32" ? "process termination" : "graceful signal shutdown"}.`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main().catch((error: unknown) => {
  console.error(
    `Binary smoke check failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
