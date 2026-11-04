import { lstat, readFile, realpath } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAppearanceToHtml, type DashboardAppearance } from "./contract.ts";
import { HttpError } from "./http.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** Locate the built `dist/` folder, failing before the server starts when it is missing. */
export async function dashboardAssets(override?: string): Promise<string> {
  try {
    const root = await realpath(
      resolve(override ?? fileURLToPath(new URL("../../dashboard/dist/", import.meta.url))),
    );
    const index = join(root, "index.html");
    const info = await lstat(index);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid index");
    await readFile(index);
    return root;
  } catch (error) {
    throw new Error(
      "Dashboard assets are unavailable. Reinstall the package, or run pnpm dashboard:build in a source checkout.",
      {
        cause: error,
      },
    );
  }
}

/**
 * Serve one asset, or `index.html` for the page's client-side routes. Paths are
 * confined to the asset root; symlinks and traversal never resolve.
 */
export async function staticFile(
  response: ServerResponse,
  assets: string,
  rawUrl: string,
  styleNonce: string,
  appearance: DashboardAppearance,
): Promise<void> {
  let path: string;
  try {
    path = decodeURIComponent(rawUrl.split("?")[0] ?? "/");
  } catch (error) {
    throw new HttpError(400, "Invalid page address.", { cause: error });
  }
  if (path.includes("\0") || path.includes("\\") || path.split("/").includes(".."))
    throw new HttpError(404, "Dashboard page not found.");
  let root: string;
  try {
    root = await realpath(assets);
  } catch (error) {
    throw new HttpError(503, "Dashboard assets are unavailable. Build the dashboard first.", {
      cause: error,
    });
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
    sendAsset(response, candidate, await readFile(resolved), styleNonce, appearance, {
      immutable: HASHED_ASSET.test(path),
    });
  } catch (error) {
    // Whatever went wrong (missing, escaped the root, unreadable), the answer is the same 404.
    throw new HttpError(404, "Dashboard page not found.", { cause: error });
  }
}

/**
 * Files Vite writes under `/assets` with a content hash in the name
 * (`index-Da5TupHm.css`). A new build gets new names, so they never go stale.
 */
const HASHED_ASSET = /^\/assets\/[^/]+-[\w-]{8}\.[a-z0-9]+$/;

/**
 * HTML gets the saved appearance and this response's stylesheet nonce before it is sent.
 * Hashed assets may be kept by the browser: without that every load fetched the fonts
 * again and showed text in a fallback font until they arrived.
 */
export function sendAsset(
  response: ServerResponse,
  name: string,
  bytes: Buffer,
  styleNonce: string,
  appearance: DashboardAppearance,
  { immutable = false }: { immutable?: boolean } = {},
): void {
  let content = bytes;
  if (extname(name) === ".html") {
    const meta = `<meta property="csp-nonce" name="plenger-style-nonce" content="${styleNonce}">`;
    const html = applyAppearanceToHtml(content.toString("utf8"), appearance);
    content = Buffer.from(
      html.includes("</head>") ? html.replace("</head>", `${meta}</head>`) : `${meta}${html}`,
    );
  }
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(name)] ?? "application/octet-stream",
    ...(immutable ? { "Cache-Control": "private, max-age=31536000, immutable" } : {}),
  });
  response.end(content);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    // Only existence matters here; the reason it is missing does not change the answer.
    return false;
  }
}
