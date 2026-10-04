import { startDashboard } from "../../dashboard/server.ts";
import { COMMON_OPTIONS, parseCommandArgs } from "../args.ts";
import { type Io, UsageError } from "../io.ts";

export const SERVE_USAGE = `Usage:
  plenger serve [path] [--port <0-65535>] [--data-dir <folder>]
  plenger serve --workspace <folder> [--port <0-65535>] [--data-dir <folder>]

Serve the dashboard on 127.0.0.1. The folder defaults to the current directory.
Port 0 chooses a free port. Open the printed URL in your browser.
Scans and project reviews are saved locally in SQLite. Clear them from Scan history.
--data-dir overrides the default Plenger application data folder.
Press Ctrl+C to stop the server. Project operations remain offline.
`;

const SERVE_OPTIONS = {
  ...COMMON_OPTIONS,
  port: { type: "string" },
  workspace: { type: "string" },
  "data-dir": { type: "string" },
} as const;

export interface ServeOptions {
  port: number;
  workspace?: string;
  dataDir?: string;
}

/** `plenger serve [path]`: run the local dashboard until interrupted. */
export async function serveCommand(argv: string[], io: Io): Promise<number> {
  return serveDashboard(parseServeArgs(argv), io);
}

export function parseServeArgs(argv: string[]): ServeOptions {
  const { values, positionals } = parseCommandArgs("serve", argv, SERVE_OPTIONS, 1);
  if (positionals[0] !== undefined && values.workspace !== undefined)
    throw new UsageError("use a positional path or --workspace, not both");
  const workspace = values.workspace ?? positionals[0];
  if (workspace === "") throw new UsageError("serve needs a nonempty workspace path");
  const dataDir = values["data-dir"];
  if (dataDir === "") throw new UsageError("--data-dir needs a nonempty path");
  return {
    port: parsePort(values.port),
    ...(workspace === undefined ? {} : { workspace }),
    ...(dataDir === undefined ? {} : { dataDir }),
  };
}

export function parsePort(value: string | undefined): number {
  if (value === undefined) return 0;
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port > 65535)
    throw new UsageError("--port must be an integer between 0 and 65535");
  return port;
}

/** Keep the CLI alive until its local server has closed. */
export async function serveDashboard(
  options: ServeOptions,
  io: Pick<Io, "stdout">,
): Promise<number> {
  const dashboard = await startDashboard(options);
  let closing = false;
  const closed = Promise.withResolvers<void>();
  const close = () => {
    if (closing) return;
    closing = true;
    void dashboard.close().then(closed.resolve, closed.reject);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  try {
    io.stdout(`Plenger dashboard: ${dashboard.url}\nPress Ctrl+C to stop.\n`);
    await closed.promise;
    return 0;
  } finally {
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
    if (!closing) await dashboard.close();
  }
}
