import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePort } from "../cli/commands/serve.ts";
import { startDashboard } from "./server.ts";

interface DevOptions {
  workspace?: string;
  dataDir?: string;
  port?: number;
  help: boolean;
}

const usage = `Usage:
  pnpm dashboard [--workspace <folder>] [--port <0-65535>] [--data-dir <folder>]

Starts the dashboard with Vite hot reload and its local project service.
--port sets the Vite development server port (default: 5173).`;

function parseOptions(args: string[]): DevOptions {
  const options: DevOptions = { help: false };
  for (let index = args[0] === "--" ? 1 : 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument !== "--workspace" && argument !== "--data-dir" && argument !== "--port")
      throw new Error(`Unknown option: ${argument}\n\n${usage}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
    index += 1;
    if (argument === "--workspace") options.workspace = value;
    else if (argument === "--data-dir") options.dataDir = value;
    else options.port = parsePort(value);
  }
  return options;
}

async function main() {
  let options: DevOptions;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(usage);
    return;
  }

  const root = fileURLToPath(new URL("../../", import.meta.url));
  const dashboardDirectory = resolve(root, "dashboard");
  const viteCli = resolve(dashboardDirectory, "node_modules/vite/bin/vite.js");
  let api: Awaited<ReturnType<typeof startDashboard>> | undefined;
  try {
    api = await startDashboard({
      port: 0,
      ...(options.workspace ? { workspace: options.workspace } : {}),
      ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    });
    console.log(`Plenger dashboard API ready at ${api.url}`);

    const vite = spawn(
      process.execPath,
      [
        viteCli,
        "--host",
        "127.0.0.1",
        ...(options.port === undefined ? [] : ["--port", String(options.port)]),
      ],
      {
        cwd: dashboardDirectory,
        env: { ...process.env, PLENGER_DASHBOARD_API_TARGET: api.url },
        stdio: "inherit",
      },
    );
    let interruptedBy: NodeJS.Signals | undefined;
    const stop = (signal: NodeJS.Signals) => {
      interruptedBy = signal;
      vite.kill(signal);
    };
    const onInterrupt = () => stop("SIGINT");
    const onTerminate = () => stop("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit, reject) => {
          vite.once("error", reject);
          vite.once("exit", (code, signal) => resolveExit({ code, signal }));
        },
      );
      process.exitCode =
        result.code ?? (interruptedBy === "SIGINT" || result.signal === "SIGINT" ? 130 : 143);
    } finally {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await api?.close();
  }
}

await main();
