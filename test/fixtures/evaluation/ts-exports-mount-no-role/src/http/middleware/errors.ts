import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);

export function errorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction) {
  if (error instanceof HttpError) return response.status(error.status).json({ error: error.message });
  if (error instanceof ZodError)
    return response.status(400).json({ error: "invalid request", issues: error.issues });
  console.error(error);
  response.status(500).json({ error: "internal error" });
}
