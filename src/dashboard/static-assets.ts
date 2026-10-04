import { lstat, readFile, realpath } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { embeddedAsset, isEmbeddedBinary } from "../shared/runtime.ts";
import { applyThemeToHtml, type DashboardTheme } from "./contract.ts";
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

/** Either a built `dist/` folder on disk or the file names embedded in the binary. */
export type AssetSource = string | Set<string>;

/** Locate the built page, failing before the server starts when it is missing. */
export async function dashboardAssets(override?: string): Promise<AssetSource> {
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
  assets: AssetSource,
  rawUrl: string,
  styleNonce: string,
  theme: DashboardTheme,
): Promise<void> {
  let path: string;
  try {
    path = decodeURIComponent(rawUrl.split("?")[0] ?? "/");
  } catch (error) {
    throw new HttpError(400, "Invalid page address.", { cause: error });
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
    sendAsset(response, candidate, await readFile(resolved), styleNonce, theme);
  } catch (error) {
    // Whatever went wrong (missing, escaped the root, unreadable), the answer is the same 404.
    throw new HttpError(404, "Dashboard page not found.", { cause: error });
  }
}

/** HTML gets the saved theme and this response's stylesheet nonce before it is sent. */
export function sendAsset(
  response: ServerResponse,
  name: string,
  bytes: Buffer,
  styleNonce: string,
  theme: DashboardTheme,
): void {
  let content = bytes;
  if (extname(name) === ".html") {
    const meta = `<meta name="plenger-style-nonce" content="${styleNonce}">`;
    const html = applyThemeToHtml(content.toString("utf8"), theme);
    content = Buffer.from(
      html.includes("</head>") ? html.replace("</head>", `${meta}</head>`) : `${meta}${html}`,
    );
  }
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(name)] ?? "application/octet-stream",
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
