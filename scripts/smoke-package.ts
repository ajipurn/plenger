import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  API,
  type DashboardScan,
  type DashboardSession,
  TOKEN_HEADER,
} from "../src/dashboard/contract.ts";
import { RUNTIME_FILES } from "../src/redteam/runtime.ts";
import { fixturePath } from "../test/support/fixtures.ts";
import { launchDashboard } from "./lib/dashboard-smoke.ts";

interface Packed {
  filename: string;
  files: { path: string }[];
}

const root = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);
const npmCli = [
  join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
].find(existsSync);

async function main() {
  assert.ok(npmCli, "The package smoke check needs Node.js with npm installed.");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    name: string;
    version: string;
    dependencies: Record<string, string>;
  };
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "plenger-package-smoke-")));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    NO_COLOR: "1",
    npm_config_cache: join(temporary, "cache"),
  };
  const npm = (args: string[], cwd = root) =>
    execute(process.execPath, [npmCli, ...args], {
      cwd,
      env,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  try {
    const output = join(root, "dist/npm");
    await mkdir(output, { recursive: true });
    const [packed] = JSON.parse(
      (await npm(["pack", "--json", "--foreground-scripts=false", "--pack-destination", output]))
        .stdout,
    ) as Packed[];
    assert.ok(packed);
    assert.equal(pkg.name, "plenger");
    assert.equal(packed.filename, `plenger-${pkg.version}.tgz`);
    const files = new Set(packed.files.map((file) => file.path));
    for (const path of [
      "LICENSE",
      "dist/bin.js",
      "dashboard/dist/index.html",
      "dist/THIRD_PARTY_NOTICES.txt",
    ]) {
      assert.ok(files.has(path), `Missing packaged asset: ${path}`);
    }
    // Exactly the recipes the container builder reads, so local leftovers never ship.
    const recipes = Object.entries(RUNTIME_FILES).flatMap(([profile, paths]) =>
      paths.map((path) => `runtimes/${profile}/${path}`),
    );
    assert.deepEqual(
      [...files].filter((path) => path.startsWith("runtimes/")).sort(),
      recipes.sort(),
      "Packaged runtime files must match RUNTIME_FILES.",
    );
    assert.ok(![...files].some((path) => /^(?:src|test|scripts|dist\/binary)\//.test(path)));
    for (const path of files) {
      const compiled = /^dist\/(.+)\.js$/.exec(path)?.[1];
      if (compiled !== undefined)
        assert.ok(existsSync(join(root, "src", `${compiled}.ts`)), `Stale compiled file: ${path}`);
    }

    // Pack the installed production dependency closure so the install needs no registry access.
    const dependencies = join(temporary, "dependencies");
    await mkdir(dependencies);
    const archives = [join(output, packed.filename)];
    const visited = new Set<string>();
    const packDependency = async (name: string, parent: string): Promise<void> => {
      const metadata = createRequire(parent)
        .resolve.paths(name)
        ?.map((path) => join(path, name, "package.json"))
        .find(existsSync);
      assert.ok(metadata, `Missing installed dependency: ${name}`);
      const filename = await realpath(metadata);
      if (visited.has(filename)) return;
      visited.add(filename);
      const [dependency] = JSON.parse(
        (
          await npm([
            "pack",
            dirname(filename),
            "--json",
            "--ignore-scripts",
            "--offline",
            "--pack-destination",
            dependencies,
          ])
        ).stdout,
      ) as Packed[];
      assert.ok(dependency);
      archives.push(join(dependencies, dependency.filename));
      const manifest = JSON.parse(await readFile(filename, "utf8")) as {
        dependencies?: Record<string, string>;
      };
      for (const child of Object.keys(manifest.dependencies ?? {}))
        await packDependency(child, filename);
    };
    for (const name of Object.keys(pkg.dependencies))
      await packDependency(name, join(root, "package.json"));
    const runtime = join(temporary, "installed");
    await mkdir(runtime);
    await npm([
      "install",
      "--prefix",
      runtime,
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
      ...archives,
    ]);
    const installed = join(runtime, "node_modules", pkg.name);
    const prefix = join(temporary, "global");
    await npm([
      "install",
      "--global",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
      ...archives,
    ]);
    const globalCommand = await execute("plenger", ["--version"], {
      cwd: runtime,
      env: {
        ...env,
        PATH: `${process.platform === "win32" ? prefix : join(prefix, "bin")}${delimiter}${env.PATH}`,
      },
      shell: process.platform === "win32",
      timeout: 30_000,
    });
    assert.equal(globalCommand.stdout.trim(), pkg.version);
    const notices = await readFile(join(installed, "dist/THIRD_PARTY_NOTICES.txt"), "utf8");
    assert.match(notices, /tree-sitter-python@/);
    assert.doesNotMatch(notices, /Node\.js@/);
    const run = (args: string[]) => npm(["exec", "--offline", "--", "plenger", ...args], runtime);
    assert.equal((await run(["--version"])).stdout.trim(), pkg.version);
    assert.match((await run(["--help"])).stdout, /--port/);
    assert.match((await run(["update", "--help"])).stdout, /confirmation/);
    const fixture = join(temporary, "project");
    await cp(fixturePath("mixed-agent"), fixture, { recursive: true });

    const server = await launchDashboard({
      program: process.execPath,
      args: [join(installed, "dist/bin.js")],
      cwd: runtime,
      workspace: fixture,
      dataDir: join(temporary, "data"),
      env,
    });
    try {
      const home = await server.fetchPage("/");
      assert.equal(home.status, 200);
      const html = await home.text();
      assert.match(html, /<title>Plenger \| Source security workspace<\/title>/);
      assert.match(html, /id="root"/);
      // The fonts load with the bundle, so text never renders in a fallback font first.
      assert.equal([...html.matchAll(/<link\s+rel="preload"\s+as="font"/g)].length, 3);
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
        (match) => match[1],
      );
      assert.ok(assets.some((path) => path?.endsWith(".js")));
      assert.ok(assets.some((path) => path?.endsWith(".css")));
      for (const asset of assets) {
        assert.ok(asset);
        const response = await server.fetchPage(asset);
        assert.equal(response.status, 200);
        // The Content Security Policy blocks fonts from data: URLs, so none may be inlined.
        if (asset.endsWith(".css"))
          assert.doesNotMatch(await response.text(), /url\(\s*["']?data:font/);
      }
      assert.equal((await server.fetchPage("/findings")).status, 200);
      // The session endpoint needs the token from the printed link.
      assert.equal((await server.fetchPage(API.session)).status, 403);
      const session = (await (
        await server.fetchPage(API.session, { headers: { [TOKEN_HEADER]: server.token } })
      ).json()) as DashboardSession;
      const response = await server.fetchPage(API.scan, {
        method: "POST",
        headers: { "Content-Type": "application/json", [TOKEN_HEADER]: session.token },
        body: JSON.stringify({ path: fixture }),
      });
      assert.equal(response.status, 200);
      const saved = (await response.json()) as DashboardScan;
      assert.equal(saved.scan.files.length, 6);
      assert.deepEqual([...new Set(saved.scan.files.map((file) => file.language))].sort(), [
        "javascript",
        "python",
        "typescript",
      ]);
      assert.ok(saved.scan.files.some((file) => file.path.endsWith(".tsx")));
      assert.ok(saved.scan.inventory.models.length > 0);
      assert.ok(saved.scan.inventory.llmCalls.length > 0);
      assert.ok(saved.scan.inventory.tools.length > 0);
      await server.stop();
    } finally {
      await server.dispose();
    }
    console.log(
      "Installed plenger launcher passed: built frontend, deep links and authenticated scan.",
    );
    console.log(`Verified npm archive: ${archives[0]}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(
    `Package smoke check failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
