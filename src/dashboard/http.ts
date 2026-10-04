import type { IncomingMessage, ServerResponse } from "node:http";
import { isRecord } from "../shared/guards.ts";

const MAX_BODY_BYTES = 8192;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

/** The message every unexpected failure is reported with; causes stay in the process. */
export const INTERNAL_ERROR_MESSAGE = "The dashboard could not complete this request. Try again.";

/** A response the handler chose; the message is shown to the person using the page. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

/** What a route handler produces; the dispatcher serialises it. */
export interface Reply {
  status: number;
  body: unknown;
}

export function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

export function requireMethod(request: IncomingMessage, method: string): void {
  if (request.method !== method) throw new HttpError(405, "This request method is not supported.");
}

/** The request body as a JSON object: small, UTF-8, `application/json`. */
export async function jsonRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!JSON_CONTENT_TYPE.test(request.headers["content-type"] ?? ""))
    throw new HttpError(415, "Send this request as JSON.");
  const bytes = await new Promise<Buffer>((resolveBody, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        parts.length = 0;
        reject(new HttpError(413, "Request body is too large."));
      } else parts.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(parts)));
    request.on("error", (error) =>
      reject(new HttpError(400, "Request was interrupted.", { cause: error })),
    );
  });
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new HttpError(400, "Request body is not valid JSON.", { cause: error });
  }
  if (!isRecord(value)) throw new HttpError(400, "Send a JSON object.");
  return value;
}

/** Reject bodies carrying keys an endpoint does not understand (so nothing is silently ignored). */
export function expectKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
  message: string,
): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new HttpError(400, message);
}

export function requireString(
  value: unknown,
  message: string,
  bounds: { min?: number; max?: number } = {},
): string {
  if (
    typeof value !== "string" ||
    value.length < (bounds.min ?? 0) ||
    value.length > (bounds.max ?? Number.POSITIVE_INFINITY)
  )
    throw new HttpError(400, message);
  return value;
}

export function requireInt(value: unknown, min: number, max: number, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new HttpError(400, message);
  return value;
}

/** Look up `?id=` on a GET endpoint: 400 without an id, 404 when nothing matches. */
export function getById<T>(
  url: URL,
  lookup: (id: string) => T | null,
  messages: { choose: string; notFound: string },
): T {
  const id = url.searchParams.get("id");
  if (!id) throw new HttpError(400, messages.choose);
  const found = lookup(id);
  if (found === null) throw new HttpError(404, messages.notFound);
  return found;
}
