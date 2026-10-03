import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { DashboardScan, DashboardSession } from "../src/dashboard/model.ts";
import type { Report } from "../src/report/model.ts";

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

    const server = spawn(binary, ["serve", fixture, "--port", "0"], {
      cwd: runtime,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    server.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    server.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (accept, reject) => {
        server.once("error", reject);
        server.once("close", (code, signal) => accept({ code, signal }));
      },
    );
    try {
      const origin = await new Promise<string>((accept, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Dashboard startup timed out. ${stderr}`)),
          15_000,
        );
        const detect = () => {
          const url = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout)?.[0];
          if (url) {
            clearTimeout(timeout);
            accept(url);
          }
        };
        server.stdout.on("data", detect);
        void exited.then(({ code, signal }) => {
          clearTimeout(timeout);
          reject(new Error(`Dashboard exited before startup (${code ?? signal}). ${stderr}`));
        }, reject);
        detect();
      });
      const fetchPage = (path: string, options: RequestInit = {}) =>
        fetch(`${origin}${path}`, {
          ...options,
          signal: AbortSignal.timeout(30_000),
        });
      const home = await fetchPage("/");
      assert.equal(home.status, 200);
      const html = await home.text();
      assert.match(html, /id="root"/);
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
      assert.equal(server.kill("SIGTERM"), true);
      const stopped = await Promise.race([
        exited,
        new Promise<never>((_accept, reject) => {
          setTimeout(() => reject(new Error("Dashboard did not stop.")), 10_000).unref();
        }),
      ]);
      if (process.platform === "win32")
        assert.ok(stopped.code === 0 || stopped.signal === "SIGTERM");
      else assert.deepEqual(stopped, { code: 0, signal: null });
      assert.equal(stderr, "");
      console.log(
        `Binary dashboard passed: embedded assets, deep links, authenticated scan, ${process.platform === "win32" ? "process termination" : "graceful signal shutdown"}.`,
      );
    } finally {
      if (server.exitCode === null && server.signalCode === null) {
        server.kill("SIGKILL");
        await exited;
      }
    }
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
