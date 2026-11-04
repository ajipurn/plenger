import assert from "node:assert/strict";
import { spawn } from "node:child_process";

interface DashboardLaunch {
  program: string;
  args?: string[];
  cwd: string;
  workspace: string;
  dataDir: string;
  env: NodeJS.ProcessEnv;
}

/** Launch the installed CLI and use its printed URL to check the real dashboard. */
export async function launchDashboard(options: DashboardLaunch) {
  const { program, args = [], cwd, workspace, dataDir, env } = options;
  const server = spawn(
    program,
    [...args, "--workspace", workspace, "--port", "0", "--data-dir", dataDir],
    {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
  const dispose = async () => {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGKILL");
      await exited;
    }
  };
  try {
    const link = await new Promise<string>((accept, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Dashboard startup timed out. ${stderr}`)),
        15_000,
      );
      const detect = () => {
        // The printed link carries the session token: `http://127.0.0.1:4180/#token=...`.
        const url = /http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+/.exec(stdout)?.[0];
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
    const { origin, hash } = new URL(link);
    return {
      /** The session token from the printed link. */
      token: new URLSearchParams(hash.slice(1)).get("token") ?? "",
      fetchPage: (path: string, options: RequestInit = {}) =>
        fetch(`${origin}${path}`, { ...options, signal: AbortSignal.timeout(30_000) }),
      dispose,
      async stop() {
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
        // The launcher drops Node 22's SQLite notice, so any stderr is a failure.
        assert.equal(stderr, "");
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
