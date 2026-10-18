import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";

/** Replaces `request.body` with its parsed value, or answers 400 with the issues. */
export function body<T>(schema: ZodType<T>) {
  return (request: Request, response: Response, next: NextFunction) => {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success)
      return response.status(400).json({ error: "invalid body", issues: parsed.error.issues });
    request.body = parsed.data;
    next();
  };
}

export function query<T>(schema: ZodType<T>, request: Request): T {
  return schema.parse(request.query);
}
