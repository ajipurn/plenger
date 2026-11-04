import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isRecord } from "../shared/guards.ts";
import { PACKAGE_NAME, PRIVATE_BUILD, VERSION } from "../shared/runtime.ts";
import { dashboardDataDirectory } from "../storage/database.ts";
import type { Io } from "./io.ts";

const REGISTRY = "https://registry.npmjs.org";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 3000;
const METADATA_BYTES = 256 * 1024;
const execute = promisify(execFile);

/** Only messages owned by the updater may be shown to the terminal. */
class UpdateError extends Error {}

export interface Updates {
  notify(io: Pick<Io, "stdout">, signal: AbortSignal): Promise<void>;
  run(io: Io): Promise<number>;
}

/** Host services are replaceable in offline tests; none are supplied by project code. */
export interface UpdateOptions {
  dataDirectory?: string;
  packageDirectory?: string;
  version?: string;
  privateBuild?: boolean;
  disabled?: boolean;
  interactive?: boolean;
  fetch?: typeof fetch;
  npm?: (args: string[], timeoutMs: number) => Promise<string>;
  confirm?: (question: string) => Promise<boolean>;
  now?: () => number;
}

interface Release {
  version: string;
}

function versionParts(value: string): number[] | null {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      value,
    );
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function stableVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value) && versionParts(value) !== null;
}

function newer(candidate: string, current: string): boolean {
  const left = versionParts(candidate);
  const right = versionParts(current);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return /^\d+\.\d+\.\d+-/.test(current);
}

async function confirmUpdate(question: string): Promise<boolean> {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(?:y|yes)$/i.test((await reader.question(question)).trim());
  } catch {
    return false;
  } finally {
    reader.close();
  }
}

/** Resolve npm's JavaScript entry so Windows never needs a shell or a .cmd invocation. */
function npmEntry(): string {
  const candidates = [
    ...(process.env.npm_execpath?.endsWith("npm-cli.js") ? [process.env.npm_execpath] : []),
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
    // A relative PATH entry names the current folder, which is not where npm lives.
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter((path) => isAbsolute(path))
      .flatMap((path) =>
        process.platform === "win32"
          ? [join(path, "node_modules/npm/bin/npm-cli.js")]
          : [join(path, "npm")],
      ),
  ];
  const entry = candidates.find(existsSync);
  if (!entry) throw new UpdateError("npm was not found. Install Node.js with npm and try again.");
  return entry;
}

async function runNpm(args: string[], timeoutMs: number): Promise<string> {
  try {
    return (
      await execute(process.execPath, [npmEntry(), ...args], {
        cwd: homedir(),
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      })
    ).stdout.trim();
  } catch {
    throw new UpdateError(
      "npm could not complete the operation. Check your connection and installation permissions, then try again.",
    );
  }
}

export function createUpdates(options: UpdateOptions = {}): Updates {
  const directory = options.dataDirectory ?? dashboardDataDirectory();
  const packageDirectory =
    options.packageDirectory ?? fileURLToPath(new URL("../../", import.meta.url));
  const current = options.version ?? VERSION;
  const privateBuild = options.privateBuild ?? PRIVATE_BUILD;
  const request = options.fetch ?? globalThis.fetch;
  const npm = options.npm ?? runNpm;
  const confirm = options.confirm ?? confirmUpdate;
  const now = options.now ?? Date.now;
  const cache = join(directory, "update-check.json");

  async function latest(signal?: AbortSignal): Promise<Release | null> {
    const deadline = AbortSignal.timeout(CHECK_TIMEOUT_MS);
    const response = await request(`${REGISTRY}/${PACKAGE_NAME}/latest`, {
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      headers: { Accept: "application/json" },
    });
    if (response.status === 404) return null;
    if (!response.ok)
      throw new UpdateError(
        "The npm registry did not return a release. Check your connection and try again.",
      );
    const reader = response.body?.getReader();
    if (!reader) throw new UpdateError("The npm registry returned an empty release.");
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > METADATA_BYTES) throw new UpdateError("Release metadata is too large.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const metadata: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isRecord(metadata) || metadata.name !== PACKAGE_NAME || !stableVersion(metadata.version))
      throw new UpdateError("The npm registry returned an invalid stable release.");
    return { version: metadata.version };
  }

  async function save(release: Release | null): Promise<void> {
    // The cache is advisory. A read-only data folder must not prevent startup or update.
    const temporary = `${cache}.${process.pid}.tmp`;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        temporary,
        JSON.stringify({ name: PACKAGE_NAME, checkedAt: now(), version: release?.version ?? null }),
        { mode: 0o600 },
      );
      await rename(temporary, cache);
    } catch {
      // A failed advisory cache write does not affect the operation.
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  return {
    async notify(io, signal) {
      if (
        privateBuild ||
        (options.disabled ?? Boolean(process.env.NO_UPDATE_NOTIFIER)) ||
        signal.aborted
      )
        return;
      try {
        let release: Release | null | undefined;
        try {
          const cached: unknown = JSON.parse(await readFile(cache, "utf8"));
          if (
            isRecord(cached) &&
            cached.name === PACKAGE_NAME &&
            typeof cached.checkedAt === "number" &&
            cached.checkedAt <= now() &&
            now() - cached.checkedAt < CHECK_INTERVAL_MS &&
            (cached.version === null || stableVersion(cached.version))
          )
            release = cached.version === null ? null : { version: cached.version };
        } catch {}
        if (release === undefined) {
          release = await latest(signal);
          if (!signal.aborted) await save(release);
        }
        if (!signal.aborted && release && newer(release.version, current))
          io.stdout(
            "Plenger " +
              release.version +
              " is available (installed: " +
              current +
              "). Run plenger update.\n",
          );
      } catch {
        // An offline registry or malformed response never interrupts the dashboard.
      }
    },

    async run(io) {
      if (privateBuild) {
        io.stderr(
          "plenger: This private build cannot update from npm. Install a new local tarball or update the source checkout through Git.\n",
        );
        return 1;
      }
      try {
        const [root, prefix] = await Promise.all([
          npm(["root", "--global"], 10_000),
          npm(["prefix", "--global"], 10_000),
        ]);
        if (!isAbsolute(root) || !isAbsolute(prefix))
          throw new UpdateError("npm returned an invalid installation folder.");
        const installed = join(root, PACKAGE_NAME);
        const sameInstallation =
          !(await lstat(installed).catch(() => null))?.isSymbolicLink() &&
          (await realpath(installed).catch(() => null)) === (await realpath(packageDirectory));
        if (!sameInstallation) {
          io.stderr(
            "plenger: This is not the npm global installation. For npx, run npx plenger@latest. Update local packages with their package manager and source checkouts through Git.\n",
          );
          return 2;
        }
        const release = await latest();
        if (!release) {
          io.stderr(
            "plenger: No published Plenger release was found. This installation is unchanged.\n",
          );
          return 1;
        }
        if (!newer(release.version, current)) {
          io.stdout(`Plenger ${current} is up to date.\n`);
          return 0;
        }
        if (
          !(options.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true))
        ) {
          io.stderr(
            "plenger: Run plenger update in an interactive terminal to confirm the update.\n",
          );
          return 2;
        }
        io.stdout("Stop any running Plenger dashboard before continuing.\n");
        if (!(await confirm(`Update Plenger ${current} to ${release.version}? [y/N] `))) {
          io.stdout("Update cancelled.\n");
          return 0;
        }
        io.stdout(`Installing Plenger ${release.version}...\n`);
        await npm(
          [
            "install",
            "--global",
            "--prefix",
            prefix,
            `${PACKAGE_NAME}@${release.version}`,
            "--ignore-scripts",
            "--engine-strict",
            `--registry=${REGISTRY}`,
          ],
          120_000,
        );
        const updated: unknown = JSON.parse(
          await readFile(join(installed, "package.json"), "utf8"),
        );
        if (
          !isRecord(updated) ||
          updated.name !== PACKAGE_NAME ||
          updated.version !== release.version
        )
          throw new UpdateError(
            "The installed version could not be verified. Check npm's installation before starting Plenger.",
          );
        io.stdout(`Updated to Plenger ${release.version}. Run plenger to start the dashboard.\n`);
        return 0;
      } catch (error) {
        // Do not expose npm's raw output, registry responses or credential-bearing config.
        io.stderr(
          "plenger: " +
            (error instanceof UpdateError
              ? error.message
              : "Could not check or install the update. Check your connection and try again.") +
            "\n",
        );
        return 1;
      }
    },
  };
}
