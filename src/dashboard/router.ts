import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, type Reply } from "./http.ts";

export interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  /** Values of `:name` segments in the matched path. */
  params: Record<string, string>;
}

/** `undefined` means the client is gone and nothing should be written. */
export type RouteHandler = (
  context: RouteContext,
) => Promise<Reply | undefined> | Reply | undefined;

export interface Route {
  method: "GET" | "POST";
  /** Exact segments, or `:name` for one non-empty segment. */
  path: string;
  handler: RouteHandler;
  /** Served without the session token; only the session endpoint itself. */
  public?: boolean;
}

export type RouteMatch =
  | { route: Route; params: Record<string, string> }
  | { route?: undefined; error: HttpError };

/**
 * Find the route for a request. A known path with the wrong method is 405, an unknown
 * path 404; the caller decides when to raise those relative to authentication.
 */
export function matchRoute(
  routes: readonly Route[],
  method: string | undefined,
  pathname: string,
): RouteMatch {
  let pathMatched = false;
  for (const route of routes) {
    const params = matchPath(route.path, pathname);
    if (params === undefined) continue;
    pathMatched = true;
    if (route.method === method) return { route, params };
  }
  return {
    error: pathMatched
      ? new HttpError(405, "This request method is not supported.")
      : new HttpError(404, "Dashboard endpoint not found."),
  };
}

function matchPath(pattern: string, pathname: string): Record<string, string> | undefined {
  const expected = pattern.split("/");
  const actual = pathname.split("/");
  if (expected.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    const value = actual[index] ?? "";
    if (!segment.startsWith(":")) {
      if (segment !== value) return undefined;
      continue;
    }
    if (value === "") return undefined;
    try {
      params[segment.slice(1)] = decodeURIComponent(value);
    } catch {
      // A malformed escape sequence cannot name anything; treat it as no match.
      return undefined;
    }
  }
  return params;
}
