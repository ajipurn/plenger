import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TOKEN_HEADER } from "./contract.ts";
import { HttpError } from "./http.ts";
import { TORPH_STYLE_SOURCE } from "./style-policy.ts";

/** Where the server is reachable; requests must name exactly this host and origin. */
export interface LocalAddress {
  host: string;
  origin: string;
}

export function newStyleNonce(): string {
  return randomBytes(16).toString("base64");
}

export function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}

/** Scripts only from the page itself; stylesheets from the page, this response's nonce and Torph. */
export function contentSecurityPolicy(styleNonce: string): string {
  return `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}' ${TORPH_STYLE_SOURCE}; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
}

/** Set on every response, including errors and static files. */
export function applySecurityHeaders(response: ServerResponse, styleNonce: string): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Content-Security-Policy", contentSecurityPolicy(styleNonce));
  response.setHeader("Cache-Control", "no-store");
}

/** Refuse DNS-rebound hosts and any page other than the dashboard's own. */
export function assertLocalRequest(request: IncomingMessage, address: LocalAddress): void {
  if (request.headers.host !== address.host)
    throw new HttpError(403, "This dashboard accepts requests from its local address only.");
  if (request.headers.origin !== undefined && request.headers.origin !== address.origin)
    throw new HttpError(403, "This dashboard accepts requests from its own page only.");
}

export function matchesToken(received: string | string[] | undefined, token: string): boolean {
  if (typeof received !== "string") return false;
  const actual = Buffer.from(received);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function requireToken(request: IncomingMessage, token: string): void {
  if (!matchesToken(request.headers[TOKEN_HEADER.toLowerCase()], token))
    throw new HttpError(403, "Dashboard session expired. Reload this page.");
}
