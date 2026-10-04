import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { embeddedAsset, isEmbeddedBinary } from "../assets.ts";
import { type BudgetLimits, ModelBudget } from "../redteam/budget.ts";
import { PreparationError, planProject } from "../redteam/plan.ts";
import { createRunProvider } from "../redteam/provider.ts";
import { executeRun, newRun, validateRunPlan } from "../redteam/run.ts";
import { RULES } from "../rules/index.ts";
import { scan } from "../scan.ts";
import { chooseNativeFolder, type FolderPicker } from "./folder-picker.ts";
import type { DashboardScan, DashboardSession, DashboardTheme, FolderListing } from "./model.ts";
import { DashboardStore } from "./store.ts";
import { TORPH_STYLE_SOURCE } from "./style-policy.ts";

const MAX_BODY_BYTES = 8192;
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface DashboardOptions {
  port?: number;
  workspace?: string;
  assets?: string;
  dataDir?: string;
  folderPicker?: FolderPicker;
  runExecutor?: typeof executeRun;
}

/** Local dashboard transport. Project operations reuse the offline engine. */
export async function startDashboard(options: DashboardOptions = {}) {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Dashboard port must be an integer between 0 and 65535.");
  const workspace = await directory(options.workspace ?? process.cwd(), process.cwd());
  const assets = await dashboardAssets(options.assets);
  const store = await DashboardStore.open(options.dataDir);
  const token = randomBytes(32).toString("hex");
  const folderPicker = options.folderPicker ?? chooseNativeFolder;
  const pickerShutdown = new AbortController();
  let host = "";
  let origin = "";
  let busy = false;
  let activeRun: { id: string; controller: AbortController; task: Promise<unknown> } | null = null;
  let pickingFolder = false;

  async function route(request: IncomingMessage, response: ServerResponse) {
    const styleNonce = randomBytes(16).toString("base64");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}' ${TORPH_STYLE_SOURCE}; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    );
    response.setHeader("Cache-Control", "no-store");
    if (request.headers.host !== host)
      throw new HttpError(403, "This dashboard accepts requests from its local address only.");
    if (request.headers.origin !== undefined && request.headers.origin !== origin)
      throw new HttpError(403, "This dashboard accepts requests from its own page only.");
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/session" && request.method === "GET") {
        const session: DashboardSession = { workspace, token, theme: store.readTheme() };
        json(response, 200, session);
        return;
      }
      if (!matchesToken(request.headers["x-plenger-token"], token))
        throw new HttpError(403, "Dashboard session expired. Reload this page.");
      if (url.pathname === "/api/state") {
        requireMethod(request, "GET");
        json(response, 200, store.read(workspace));
        return;
      }
      if (url.pathname === "/api/theme") {
        requireMethod(request, "POST");
        const body = await jsonRequest(request);
        if (
          (body.theme !== "dark" && body.theme !== "light") ||
          Object.keys(body).some((key) => key !== "theme")
        )
          throw new HttpError(400, "Choose dark or light mode.");
        store.saveTheme(body.theme);
        json(response, 200, { theme: body.theme });
        return;
      }
      if (url.pathname === "/api/state/clear" || url.pathname === "/api/history/open") {
        requireMethod(request, "POST");
        const body = await jsonRequest(request);
        if (busy || activeRun)
          throw new HttpError(409, "Another project operation is running. Try again shortly.");
        if (url.pathname === "/api/state/clear") {
          if (Object.keys(body).length !== 0)
            throw new HttpError(400, "Clear request contains unsupported options.");
          store.clear();
        } else {
          if (
            typeof body.id !== "string" ||
            body.id.length > 128 ||
            Object.keys(body).some((key) => key !== "id")
          )
            throw new HttpError(400, "Choose a saved scan.");
          if (!store.openScan(body.id))
            throw new HttpError(404, "This saved scan is no longer available.");
        }
        json(response, 200, store.read(workspace));
        return;
      }
      if (url.pathname === "/api/redteam/run") {
        requireMethod(request, "GET");
        const id = url.searchParams.get("id");
        if (!id) throw new HttpError(400, "Choose a run.");
        const run = store.readRun(id);
        if (!run) throw new HttpError(404, "Run not found.");
        json(response, 200, run);
        return;
      }
      if (url.pathname === "/api/redteam/cancel") {
        requireMethod(request, "POST");
        const body = await jsonRequest(request);
        if (!activeRun || body.id !== activeRun.id || Object.keys(body).some((key) => key !== "id"))
          throw new HttpError(409, "This run is no longer active.");
        activeRun.controller.abort();
        json(response, 202, { cancelled: true });
        return;
      }
      if (url.pathname === "/api/redteam/start") {
        requireMethod(request, "POST");
        const body = await jsonRequest(request);
        if (busy || activeRun) throw new HttpError(409, "Another project operation is running.");
        if (
          Object.keys(body).some(
            (key) =>
              !["path", "target", "sourceDigest", "provider", "model", "apiKey", "limits"].includes(
                key,
              ),
          ) ||
          typeof body.path !== "string" ||
          typeof body.target !== "string" ||
          typeof body.sourceDigest !== "string" ||
          !/^[a-f0-9]{64}$/.test(body.sourceDigest) ||
          typeof body.model !== "string" ||
          (body.provider !== "openai" &&
            body.provider !== "ollama" &&
            body.provider !== "gemini") ||
          (body.apiKey !== undefined && typeof body.apiKey !== "string")
        )
          throw new HttpError(
            400,
            "Review a supported target and configure model access before starting.",
          );
        const limits = body.limits as BudgetLimits | undefined;
        if (
          !limits ||
          typeof limits !== "object" ||
          Array.isArray(limits) ||
          Object.keys(limits).some(
            (key) => !["maxModelCalls", "maxTokens", "timeoutMs"].includes(key),
          ) ||
          ![limits.maxModelCalls, limits.maxTokens, limits.timeoutMs].every(Number.isSafeInteger) ||
          limits.maxModelCalls < 1 ||
          limits.maxModelCalls > 30 ||
          limits.maxTokens < 1 ||
          limits.maxTokens > 2_000_000 ||
          limits.timeoutMs < 1000 ||
          limits.timeoutMs > 600_000
        )
          throw new HttpError(
            400,
            "Use 1–30 model calls, up to 2000000 tokens and a 1–600 second deadline.",
          );
        const probe = new ModelBudget(limits);
        probe.finish();
        let provider: ReturnType<typeof createRunProvider>;
        try {
          provider = createRunProvider({
            provider: body.provider,
            model: body.model,
            ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey as string }),
          });
        } catch {
          throw new HttpError(400, "Check your provider, model ID and API key.");
        }
        busy = true;
        try {
          const path = await directory(body.path, workspace);
          let plan: Awaited<ReturnType<typeof planProject>>;
          try {
            plan = await planProject(path, { target: body.target });
          } catch (error) {
            if (error instanceof PreparationError)
              throw new HttpError(400, "Select a supported candidate from a fresh project review.");
            throw error;
          }
          try {
            validateRunPlan(plan);
          } catch {
            throw new HttpError(
              400,
              "This target is outside the supported llmfy file-test or Next.js booking/SQLite runtime profile. Review the preparation details.",
            );
          }
          if (plan.sourceDigest !== body.sourceDigest)
            throw new HttpError(
              409,
              "Project changed since review. Refresh the plan before starting.",
            );
          const controller = new AbortController();
          const runOptions = {
            ...(plan.nextProfile ? { profile: plan.nextProfile.id } : {}),
            target: body.target,
            sourceDigest: body.sourceDigest,
            limits,
            provider,
            signal: controller.signal,
            onUpdate: (run: Parameters<typeof store.saveRun>[0]) => store.saveRun(run),
          };
          const run = newRun(path, runOptions);
          store.saveRun(run, {
            target: run.target,
            provider: body.provider,
            model: body.model,
            limits,
          });
          const task = (options.runExecutor ?? executeRun)(run, runOptions)
            .catch(() => {
              run.state = "failed";
              run.finishedAt = new Date().toISOString();
              run.cleanupConfirmed = false;
              run.error = "Run failed before cleanup could be confirmed.";
              store.saveRun(run);
            })
            .finally(() => {
              activeRun = null;
            });
          activeRun = { id: run.id, controller, task };
          json(response, 202, run);
        } finally {
          busy = false;
        }
        return;
      }
      if (url.pathname === "/api/folders") {
        requireMethod(request, "GET");
        json(response, 200, await folders(url.searchParams.get("path") ?? workspace, workspace));
        return;
      }
      if (url.pathname === "/api/folders/choose") {
        requireMethod(request, "POST");
        const body = await projectRequest(request, false);
        const path = await directory(body.path, workspace);
        if (response.destroyed) return;
        if (pickingFolder)
          throw new HttpError(
            409,
            "A folder picker is already open. Finish or cancel that dialog.",
          );
        pickingFolder = true;
        try {
          let selected: string | null;
          try {
            selected = await folderPicker(path, pickerShutdown.signal);
          } catch {
            throw new HttpError(
              503,
              "The system folder picker could not be opened. Browse the folders below or enter a path and press Enter.",
            );
          }
          if (response.destroyed) return;
          json(response, 200, {
            folder: selected === null ? null : await folders(selected, workspace),
          });
        } finally {
          pickingFolder = false;
        }
        return;
      }
      if (
        url.pathname === "/api/scan" ||
        url.pathname === "/api/plan" ||
        url.pathname === "/api/project"
      ) {
        requireMethod(request, "POST");
        const body = await projectRequest(request, url.pathname === "/api/plan");
        if (busy || activeRun)
          throw new HttpError(409, "Another project operation is running. Try again shortly.");
        busy = true;
        try {
          const path = await directory(body.path, workspace);
          if (url.pathname === "/api/project") {
            store.selectProject(path);
            json(response, 200, store.read(workspace));
          } else if (url.pathname === "/api/scan") {
            const result: DashboardScan = {
              id: randomUUID(),
              createdAt: new Date().toISOString(),
              scan: await scan(path),
              rules: RULES,
            };
            store.saveScan(result);
            json(response, 200, result);
          } else {
            const result = await planProject(
              path,
              body.target === undefined ? {} : { target: body.target },
            );
            store.savePlan(result);
            json(response, 200, result);
          }
        } finally {
          busy = false;
        }
        return;
      }
      throw new HttpError(404, "Dashboard endpoint not found.");
    }
    requireMethod(request, "GET");
    await staticFile(response, assets, request.url ?? "/", styleNonce, store.readTheme());
  }

  const requests = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const pending = route(request, response)
      .catch((error: unknown) => {
        if (response.destroyed) return;
        if (response.headersSent) {
          response.end();
          return;
        }
        const failure = error instanceof HttpError ? error : null;
        json(response, failure?.status ?? 500, {
          error: failure?.message ?? "Project operation failed. Check the project and try again.",
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
    server.close();
    server.closeAllConnections();
    store.close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Dashboard did not start.");
  host = `127.0.0.1:${address.port}`;
  origin = `http://${host}`;
  let closing: Promise<void> | undefined;
  return {
    url: origin,
    async close() {
      closing ??= (async () => {
        pickerShutdown.abort();
        activeRun?.controller.abort();
        try {
          await new Promise<void>((resolveClose, reject) => {
            server.close((error) => (error ? reject(error) : resolveClose()));
            server.closeAllConnections();
          });
        } finally {
          await Promise.allSettled(requests);
          await activeRun?.task;
          store.close();
        }
      })();
      await closing;
    },
  };
}

function matchesToken(received: string | string[] | undefined, token: string): boolean {
  if (typeof received !== "string") return false;
  const actual = Buffer.from(received);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requireMethod(request: IncomingMessage, method: string) {
  if (request.method !== method) throw new HttpError(405, "This request method is not supported.");
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function directory(path: string, workspace: string): Promise<string> {
  if (path.length === 0 || path.length > 4096 || path.includes("\0"))
    throw new HttpError(400, "Choose an existing project folder.");
  try {
    const canonical = await realpath(isAbsolute(path) ? path : resolve(workspace, path));
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new HttpError(400, "Choose an existing project folder.");
  }
}

async function folders(path: string, workspace: string): Promise<FolderListing> {
  const canonical = await directory(path, workspace);
  try {
    const children = (await readdir(canonical, { withFileTypes: true }))
      .filter(
        (entry) => !entry.name.startsWith(".") && entry.isDirectory() && !entry.isSymbolicLink(),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 500)
      .map((entry) => ({ name: entry.name, path: join(canonical, entry.name) }));
    const parent = dirname(canonical);
    return { path: canonical, parent: parent === canonical ? null : parent, folders: children };
  } catch {
    throw new HttpError(400, "This folder could not be opened.");
  }
}

async function projectRequest(request: IncomingMessage, allowTarget: boolean) {
  const body = await jsonRequest(request);
  if (
    typeof body.path !== "string" ||
    Object.keys(body).some((key) => key !== "path" && !(allowTarget && key === "target")) ||
    (body.target !== undefined &&
      (typeof body.target !== "string" || body.target.length > 128 || body.target.length === 0))
  )
    throw new HttpError(400, "Project request contains unsupported options.");
  return body as { path: string; target?: string };
}

async function jsonRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? ""))
    throw new HttpError(415, "Send this request as JSON.");
  const bytes = await new Promise<Buffer>((resolveBody, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        parts.length = 0;
        reject(new HttpError(413, "Project request is too large."));
      } else parts.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(parts)));
    request.on("error", () => reject(new HttpError(400, "Project request was interrupted.")));
  });
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "Project request is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new HttpError(400, "Choose a project folder.");
  return value as Record<string, unknown>;
}

async function staticFile(
  response: ServerResponse,
  assets: string | Set<string>,
  rawUrl: string,
  styleNonce: string,
  theme: DashboardTheme,
) {
  let path: string;
  try {
    path = decodeURIComponent(rawUrl.split("?")[0] ?? "/");
  } catch {
    throw new HttpError(400, "Invalid page address.");
  }
  if (path.includes("\0") || path.includes("\\") || path.split("/").includes(".."))
    throw new HttpError(404, "Dashboard page not found.");
  if (assets instanceof Set) {
    let name = path.slice(1);
    if (path === "/" || (!extname(path) && !assets.has(name))) name = "index.html";
    if (!assets.has(name)) throw new HttpError(404, "Dashboard page not found.");
    const content = embeddedAsset(`dashboard/${name}`);
    if (content === undefined) throw new HttpError(503, "Dashboard assets are unavailable.");
    sendAsset(response, name, content, styleNonce, theme);
    return;
  }
  let root: string;
  try {
    root = await realpath(assets);
  } catch {
    throw new HttpError(503, "Dashboard assets are unavailable. Build the dashboard first.");
  }
  let candidate = resolve(root, `.${path}`);
  const within = (file: string) => {
    const distance = relative(root, file);
    return distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
  };
  if (!within(candidate)) throw new HttpError(404, "Dashboard page not found.");
  try {
    if (path === "/" || (!extname(path) && !(await exists(candidate))))
      candidate = join(root, "index.html");
    const resolved = await realpath(candidate);
    const info = await lstat(candidate);
    if (!within(resolved) || !info.isFile() || info.isSymbolicLink())
      throw new Error("invalid asset");
    sendAsset(response, candidate, await readFile(resolved), styleNonce, theme);
  } catch {
    throw new HttpError(404, "Dashboard page not found.");
  }
}

async function dashboardAssets(override?: string): Promise<string | Set<string>> {
  if (override === undefined && isEmbeddedBinary) {
    const manifest = embeddedAsset("dashboard/manifest.json");
    if (manifest === undefined) throw new Error("Dashboard assets are unavailable.");
    const files: unknown = JSON.parse(manifest.toString("utf8"));
    if (!Array.isArray(files) || !files.every((name) => typeof name === "string"))
      throw new Error("Dashboard asset manifest is invalid.");
    const assets = new Set<string>(files);
    if (!assets.has("index.html") || embeddedAsset("dashboard/index.html") === undefined)
      throw new Error("Dashboard assets are unavailable.");
    return assets;
  }
  try {
    const root = await realpath(
      resolve(override ?? fileURLToPath(new URL("../../dashboard/dist/", import.meta.url))),
    );
    const index = join(root, "index.html");
    const info = await lstat(index);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid index");
    await readFile(index);
    return root;
  } catch {
    throw new Error("Dashboard assets are unavailable. Run pnpm dashboard:build first.");
  }
}

function sendAsset(
  response: ServerResponse,
  name: string,
  bytes: Buffer,
  styleNonce: string,
  theme: DashboardTheme,
) {
  let content = bytes;
  if (extname(name) === ".html") {
    const meta = `<meta name="plenger-style-nonce" content="${styleNonce}">`;
    const html = content
      .toString("utf8")
      .replace(
        /<html\b([^>]*)>/i,
        (_match, attributes: string) =>
          `<html${attributes.replace(/\sdata-theme="[^"]*"/i, "")} data-theme="${theme}">`,
      )
      .replace(/name="color-scheme" content="[^"]*"/, `name="color-scheme" content="${theme}"`)
      .replace(
        /name="theme-color" content="[^"]*"/,
        `name="theme-color" content="${theme === "dark" ? "#0b0b0b" : "#fafafa"}"`,
      );
    content = Buffer.from(
      html.includes("</head>") ? html.replace("</head>", `${meta}</head>`) : `${meta}${html}`,
    );
  }
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(name)] ?? "application/octet-stream",
  });
  response.end(content);
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
