import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { RUNTIME_FILES } from "../src/redteam/runtime.ts";
import { writeBinaryNotices } from "./binary-notices.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist/binary");
const executableName = process.platform === "win32" ? "plenger.exe" : "plenger";
const executable = join(output, executableName);
const require = createRequire(import.meta.url);
const { inject } = require("postject") as {
  inject: (
    filename: string,
    resource: string,
    data: Buffer,
    options: { sentinelFuse: string; machoSegmentName?: string },
  ) => Promise<void>;
};

function run(command: string, args: string[], shell = false) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args[0] ?? ""} failed (${result.status ?? result.signal})`);
}

async function files(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await files(directory, path)));
    else if (entry.isFile()) found.push(path);
    else throw new Error(`Binary assets must be regular files: ${path}`);
  }
  return found.sort();
}

async function main() {
  if (!["darwin", "linux", "win32"].includes(process.platform))
    throw new Error(`Native binary builds do not support ${process.platform}.`);
  const version = (
    JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  console.log(
    `Building plenger ${version} for ${process.platform}-${process.arch} with Node ${process.versions.node}`,
  );
  run(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["dashboard:build"],
    process.platform === "win32",
  );
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(output, ".build-"));
  try {
    const dashboard = join(root, "dashboard/dist");
    const dashboardFiles = await files(dashboard);
    if (!dashboardFiles.includes("index.html"))
      throw new Error("Dashboard build has no index.html.");
    const manifest = join(temporary, "dashboard-manifest.json");
    await writeFile(manifest, JSON.stringify(dashboardFiles));
    const assets: Record<string, string> = {
      "package.json": join(root, "package.json"),
      "runtime/web-tree-sitter.wasm": require.resolve("web-tree-sitter/web-tree-sitter.wasm"),
      "dashboard/manifest.json": manifest,
    };
    for (const name of ["python", "javascript", "typescript", "tsx"]) {
      const filename = `tree-sitter-${name}.wasm`;
      assets[`grammars/${filename}`] = join(root, "grammars", filename);
    }
    for (const filename of dashboardFiles)
      assets[`dashboard/${filename}`] = join(dashboard, filename);
    for (const [profile, filenames] of Object.entries(RUNTIME_FILES))
      for (const filename of filenames)
        assets[`runtimes/${profile}/${filename}`] = join(root, "runtimes", profile, filename);

    const bundle = join(temporary, "plenger.cjs");
    await build({
      stdin: {
        contents: `import { main } from "./src/cli/index.ts";
main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
  console.error("plenger:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});`,
        loader: "ts",
        resolveDir: root,
        sourcefile: "binary-entry.ts",
      },
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      alias: { "web-tree-sitter": require.resolve("web-tree-sitter") },
      define: { "import.meta.url": "__plengerModuleUrl" },
      banner: {
        js: 'const __plengerModuleUrl = require("node:url").pathToFileURL(__filename).href;',
      },
      legalComments: "eof",
    });
    const blob = join(temporary, "plenger.blob");
    const configuration = join(temporary, "sea.json");
    await writeFile(
      configuration,
      JSON.stringify({
        main: bundle,
        output: blob,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        assets,
      }),
    );
    run(process.execPath, ["--experimental-sea-config", configuration]);
    // Prepare a fresh file so repeat builds never rewrite a previously executed inode.
    const stagedExecutable = join(temporary, executableName);
    await copyFile(process.execPath, stagedExecutable, constants.COPYFILE_FICLONE);
    await chmod(stagedExecutable, 0o755);
    if (process.platform === "darwin") run("codesign", ["--remove-signature", stagedExecutable]);
    await inject(stagedExecutable, "NODE_SEA_BLOB", await readFile(blob), {
      sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
      ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
    });
    if (process.platform === "darwin") {
      run("codesign", ["--sign", "-", stagedExecutable]);
      run("codesign", ["--verify", "--strict", stagedExecutable]);
    }
    await rename(stagedExecutable, executable);

    const noticesName = "THIRD_PARTY_NOTICES.txt";
    await writeBinaryNotices(root, join(output, noticesName));
    const archiveFiles = [executableName, noticesName];
    if (existsSync(join(root, "LICENSE"))) {
      await copyFile(join(root, "LICENSE"), join(output, "LICENSE"));
      archiveFiles.push("LICENSE");
    }

    const archiveName = `plenger-${version}-${process.platform}-${process.arch}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
    const archive = join(output, archiveName);
    await rm(archive, { force: true });
    if (process.platform === "win32") {
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
      run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Compress-Archive -LiteralPath @(${archiveFiles.map((name) => quote(join(output, name))).join(",")}) -DestinationPath ${quote(archive)} -Force`,
      ]);
    } else run("tar", ["-czf", archive, "-C", output, ...archiveFiles]);
    const checksum = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    await writeFile(join(output, "SHA256SUMS"), `${checksum}  ${basename(archive)}\n`);
    console.log(`Standalone executable: ${resolve(executable)}`);
    console.log(`Archive: ${archiveName} (SHA256SUMS written)`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main().catch((error: unknown) => {
  console.error(`Binary build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
