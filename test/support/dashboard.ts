import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  API,
  type DashboardSession,
  type DashboardState,
  TOKEN_HEADER,
  TOKEN_LINK_PARAMETER,
} from "../../src/dashboard/contract.ts";
import { type DashboardOptions, startDashboard } from "../../src/dashboard/server.ts";

/** A shell with the theme markup the service rewrites, enough for every API test. */
export const INDEX_HTML =
  '<html lang="en" data-theme="dark"><head><meta name="color-scheme" content="dark"><meta name="theme-color" content="#0b0b0b"></head><body>Dashboard</body></html>';

export interface TestDashboardOptions
  extends Omit<DashboardOptions, "assets" | "dataDir" | "port"> {
  /** Temporary folder owned by the test; assets and data live beneath it unless given. */
  root: string;
  assets?: string;
  dataDir?: string;
  /** Contents of the served `index.html`. */
  html?: string;
}

export interface TestDashboard {
  url: string;
  session: DashboardSession;
  /** What the service logged, instead of standard error. */
  logs: string[];
  /** GET without a body, POST with one; the token and JSON content type are preset. */
  request(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  state(): Promise<DashboardState>;
  close(): Promise<void>;
}

/** Write a minimal built page into `assets` so `startDashboard` has something to serve. */
export async function writeTestAssets(assets: string, html = INDEX_HTML): Promise<string> {
  await mkdir(assets, { recursive: true });
  await writeFile(join(assets, "index.html"), html);
  return assets;
}

/** Start a dashboard against a temporary folder and fetch its session once. */
export async function startTestDashboard(options: TestDashboardOptions): Promise<TestDashboard> {
  const { root, html, assets: assetsOverride, dataDir: dataDirOverride, ...rest } = options;
  const assets = await writeTestAssets(assetsOverride ?? join(root, "assets"), html);
  const logs: string[] = [];
  const dashboard = await startDashboard({
    log: (line) => logs.push(line),
    ...rest,
    assets,
    dataDir: dataDirOverride ?? join(root, "data"),
    pricingLoader:
      rest.pricingLoader ??
      (async () => {
        throw new Error("No public pricing in this offline test.");
      }),
    windowLoader:
      rest.windowLoader ??
      (async () => {
        throw new Error("No public model windows in this offline test.");
      }),
  });
  const token = new URLSearchParams(new URL(dashboard.link).hash.slice(1)).get(
    TOKEN_LINK_PARAMETER,
  );
  const session = (await (
    await fetch(`${dashboard.url}${API.session}`, { headers: { [TOKEN_HEADER]: token ?? "" } })
  ).json()) as DashboardSession;
  const request: TestDashboard["request"] = (path, body, headers = {}) =>
    fetch(`${dashboard.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", [TOKEN_HEADER]: session.token, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    url: dashboard.url,
    session,
    logs,
    request,
    state: async () => (await (await request(API.state)).json()) as DashboardState,
    close: () => dashboard.close(),
  };
}

/** Narrow an optional lookup result, failing the test with `what` when it is missing. */
export function required<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`Missing ${what}.`);
  return value;
}
