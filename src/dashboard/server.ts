import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { executeCampaign } from "../redteam/campaign.ts";
import { executeRun } from "../redteam/run.ts";
import { DashboardStore } from "../storage/store.ts";
import { ChatgptLogin } from "./chatgpt-login.ts";
import { chooseNativeFolder, type FolderPicker } from "./folder-picker.ts";
import { HttpError, INTERNAL_ERROR_MESSAGE, json, requireMethod } from "./http.ts";
import { OperationSupervisor } from "./operations.ts";
import { matchRoute, type Route } from "./router.ts";
import { dashboardRoutes } from "./routes/index.ts";
import {
  applySecurityHeaders,
  assertLocalRequest,
  type LocalAddress,
  newSessionToken,
  newStyleNonce,
  requireToken,
} from "./security.ts";
import { SecurityCoordinator } from "./security-coordinator.ts";
import type { Services } from "./services.ts";
import { dashboardAssets, staticFile } from "./static-assets.ts";
import { resolveDirectory } from "./workspace.ts";

export interface DashboardOptions {
  port?: number;
  workspace?: string;
  assets?: string;
  dataDir?: string;
  folderPicker?: FolderPicker;
  runExecutor?: typeof executeRun;
  campaignExecutor?: typeof executeCampaign;
}

export interface Dashboard {
  url: string;
  close(): Promise<void>;
}

/**
 * The local dashboard service on 127.0.0.1: static page, authenticated JSON API and
 * SQLite-backed state. Project operations reuse the offline engine.
 */
export async function startDashboard(options: DashboardOptions = {}): Promise<Dashboard> {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Dashboard port must be an integer between 0 and 65535.");
  const workspace = await resolveDirectory(options.workspace ?? process.cwd(), process.cwd());
  const assets = await dashboardAssets(options.assets);
  const store = await DashboardStore.open(options.dataDir);
  const token = newSessionToken();
  const supervisor = new OperationSupervisor();
  const security = new SecurityCoordinator(store, supervisor);
  const chatgptLogin = new ChatgptLogin(store.providers);
  const services: Services = {
    workspace,
    token,
    store,
    supervisor,
    security,
    chatgptLogin,
    folderPicker: options.folderPicker ?? chooseNativeFolder,
    runExecutor: options.runExecutor ?? executeRun,
    campaignExecutor: options.campaignExecutor ?? executeCampaign,
  };
  const routes = dashboardRoutes(services);
  const address: LocalAddress = { host: "", origin: "" };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const styleNonce = newStyleNonce();
    applySecurityHeaders(response, styleNonce);
    assertLocalRequest(request, address);
    const url = new URL(request.url ?? "/", address.origin);
    if (url.pathname.startsWith("/api/")) {
      await dispatch(routes, token, { request, response, url });
      return;
    }
    requireMethod(request, "GET");
    await staticFile(response, assets, request.url ?? "/", styleNonce, store.readTheme());
  }

  const requests = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const pending = handle(request, response)
      .catch((error: unknown) => {
        if (response.destroyed) return;
        if (response.headersSent) {
          response.end();
          return;
        }
        const failure = error instanceof HttpError ? error : null;
        json(response, failure?.status ?? 500, {
          error: failure?.message ?? INTERNAL_ERROR_MESSAGE,
        });
      })
      .finally(() => requests.delete(pending));
    requests.add(pending);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolveListen();
      });
    });
    if (options.workspace !== undefined) store.selectProject(workspace);
  } catch (error) {
    await security.close();
    server.close();
    server.closeAllConnections();
    store.close();
    throw error;
  }
  const bound = server.address();
  if (bound === null || typeof bound === "string") throw new Error("Dashboard did not start.");
  address.host = `127.0.0.1:${bound.port}`;
  address.origin = `http://${address.host}`;
  let closing: Promise<void> | undefined;
  return {
    url: address.origin,
    async close() {
      closing ??= (async () => {
        supervisor.abortAll();
        await security.close();
        try {
          await new Promise<void>((resolveClose, reject) => {
            server.close((error) => (error ? reject(error) : resolveClose()));
            server.closeAllConnections();
          });
        } finally {
          // In-flight handlers and the active run must finish writing before SQLite closes.
          await Promise.allSettled(requests);
          await supervisor.settled();
          await chatgptLogin.close();
          store.close();
        }
      })();
      await closing;
    },
  };
}

/** Authenticate (except the session route), match, run the handler and send its reply. */
async function dispatch(
  routes: readonly Route[],
  token: string,
  context: { request: IncomingMessage; response: ServerResponse; url: URL },
): Promise<void> {
  const match = matchRoute(routes, context.request.method, context.url.pathname);
  if (!match.route?.public) requireToken(context.request, token);
  if (!match.route) throw match.error;
  const reply = await match.route.handler({ ...context, params: match.params });
  if (reply === undefined || context.response.destroyed) return;
  json(context.response, reply.status, reply.body);
}
