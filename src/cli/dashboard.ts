import { startDashboard } from "../dashboard/server.ts";
import { COMMON_OPTIONS, parseCommandArgs } from "./args.ts";
import { type Io, UsageError } from "./io.ts";
import type { Updates } from "./update.ts";

export interface DashboardArguments {
  port: number;
  workspace?: string;
  dataDir?: string;
}

export function parseDashboardArgs(argv: string[]): {
  options: DashboardArguments;
  help: boolean;
  version: boolean;
} {
  const { values } = parseCommandArgs(
    "plenger",
    argv,
    {
      ...COMMON_OPTIONS,
      version: { type: "boolean", short: "v" },
      port: { type: "string" },
      workspace: { type: "string" },
      "data-dir": { type: "string" },
    } as const,
    0,
  );
  if (values.workspace === "") throw new UsageError("--workspace needs a nonempty folder");
  if (values["data-dir"] === "") throw new UsageError("--data-dir needs a nonempty folder");
  return {
    options: {
      port: parsePort(values.port),
      ...(values.workspace === undefined ? {} : { workspace: values.workspace }),
      ...(values["data-dir"] === undefined ? {} : { dataDir: values["data-dir"] }),
    },
    help: values.help === true,
    version: values.version === true,
  };
}

export function parsePort(value: string | undefined): number {
  if (value === undefined) return 0;
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port > 65535)
    throw new UsageError("--port must be an integer between 0 and 65535");
  return port;
}

/** Keep the dashboard alive until shutdown; update checks never delay startup. */
export async function launchDashboard(
  options: DashboardArguments,
  io: Pick<Io, "stdout">,
  updates: Updates,
): Promise<number> {
  const dashboard = await startDashboard(options);
  const controller = new AbortController();
  let closing = false;
  const closed = Promise.withResolvers<void>();
  const close = () => {
    if (closing) return;
    closing = true;
    controller.abort();
    void dashboard.close().then(closed.resolve, closed.reject);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  let checking: Promise<void> | undefined;
  try {
    io.stdout(`Plenger dashboard: ${dashboard.url}\nPress Ctrl+C to stop.\n`);
    checking = updates.notify(io, controller.signal).catch(() => undefined);
    await closed.promise;
    return 0;
  } finally {
    controller.abort();
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
    if (!closing) await dashboard.close();
    await checking;
  }
}
