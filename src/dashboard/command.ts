import type { Io } from "../cli.ts";
import { startDashboard } from "./server.ts";

export const SERVE_USAGE = `Usage:
  plenger serve [path] [--port <0-65535>]
  plenger serve --workspace <folder> [--port <0-65535>]

Serve the dashboard on 127.0.0.1. The folder defaults to the current directory.
Port 0 chooses a free port. Open the printed URL in your browser.
Press Ctrl+C to stop the server. Project operations remain offline.
`;

/** Keep the CLI alive until its local server has closed. */
export async function serveDashboard(
  options: { port: number; workspace?: string },
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
