import type { NextFunction, Request, Response } from "express";
import { session } from "../../auth/context.ts";
import { atLeast, type Role } from "../../auth/roles.ts";

export function requireRole(minimum: Role) {
  return (_request: Request, response: Response, next: NextFunction) => {
    if (!atLeast(session(response).role, minimum))
      return response.status(403).json({ error: `requires the ${minimum} role` });
    next();
  };
}
