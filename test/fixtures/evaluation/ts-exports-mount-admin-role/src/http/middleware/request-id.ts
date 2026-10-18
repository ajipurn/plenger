import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const VALID = /^[\w-]{8,64}$/;

/** Echoes a well-formed `x-request-id`, or assigns one, so logs can follow a request. */
export function requestId(request: Request, response: Response, next: NextFunction) {
  const incoming = request.get("x-request-id");
  const id = incoming && VALID.test(incoming) ? incoming : randomUUID();
  response.locals.requestId = id;
  response.set("x-request-id", id);
  next();
}
