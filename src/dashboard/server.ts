import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { embeddedAsset, isEmbeddedBinary } from "../assets.ts";
import { planProject } from "../redteam/plan.ts";
import { RULES } from "../rules/index.ts";
import { scan } from "../scan.ts";
import type { DashboardScan, DashboardSession, FolderListing } from "./model.ts";
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
}

/** Local dashboard transport. Project operations reuse the offline engine. */
export async function startDashboard(options: DashboardOptions = {}) {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Dashboard port must be an integer between 0 and 65535.");
  const workspace = await directory(options.workspace ?? process.cwd(), process.cwd());
  const assets = await dashboardAssets(options.assets);
  const token = randomBytes(32).toString("hex");
  let host = "";
  let origin = "";
  let busy = false;

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
        const session: DashboardSession = { workspace, token };
        json(response, 200, session);
        return;
      }
      if (!matchesToken(request.headers["x-plenger-token"], token))
        throw new HttpError(403, "Dashboard session expired. Reload this page.");
      if (url.pathname === "/api/folders") {
        requireMethod(request, "GET");
        json(response, 200, await folders(url.searchParams.get("path") ?? workspace, workspace));
        return;
      }
      if (url.pathname === "/api/scan" || url.pathname === "/api/plan") {
        requireMethod(request, "POST");
        const body = await projectRequest(request, url.pathname === "/api/plan");
        if (busy)
          throw new HttpError(409, "Another project operation is running. Try again shortly.");
        busy = true;
        try {
          const path = await directory(body.path, workspace);
          if (url.pathname === "/api/scan") {
            const result: DashboardScan = {
              id: randomUUID(),
              createdAt: new Date().toISOString(),
              scan: await scan(path),
              rules: RULES,
            };
            json(response, 200, result);
          } else {
            const result = await planProject(
              path,
              body.target === undefined ? {} : { target: body.target },
            );
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
    await staticFile(response, assets, request.url ?? "/", styleNonce);
  }

  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      const failure = error instanceof HttpError ? error : null;
      json(response, failure?.status ?? 500, {
        error: failure?.message ?? "Project operation failed. Check the project and try again.",
      });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Dashboard did not start.");
  host = `127.0.0.1:${address.port}`;
  origin = `http://${host}`;
  return {
    url: origin,
    async close() {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
        server.closeAllConnections();
      });
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
  const body = value as Record<string, unknown>;
  if (
    typeof body.path !== "string" ||
    Object.keys(body).some((key) => key !== "path" && !(allowTarget && key === "target")) ||
    (body.target !== undefined &&
      (typeof body.target !== "string" || body.target.length > 128 || body.target.length === 0))
  )
    throw new HttpError(400, "Project request contains unsupported options.");
  return body as { path: string; target?: string };
}

async function staticFile(
  response: ServerResponse,
  assets: string | Set<string>,
  rawUrl: string,
  styleNonce: string,
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
    sendAsset(response, name, content, styleNonce);
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
    sendAsset(response, candidate, await readFile(resolved), styleNonce);
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

function sendAsset(response: ServerResponse, name: string, bytes: Buffer, styleNonce: string) {
  let content = bytes;
  if (extname(name) === ".html") {
    const meta = `<meta name="plenger-style-nonce" content="${styleNonce}">`;
    const html = content.toString("utf8");
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
