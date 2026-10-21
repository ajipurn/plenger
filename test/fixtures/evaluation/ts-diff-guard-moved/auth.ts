import type { NextFunction, Request, Response } from "express";

export function requireAdmin(request: Request, response: Response, next: NextFunction) {
  if (request.user?.role !== "admin") return response.status(403).end();
  next();
}
