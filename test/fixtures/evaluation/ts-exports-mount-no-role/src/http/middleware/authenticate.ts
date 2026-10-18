import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../db.ts";
import { readSession } from "../../auth/session.ts";

function bearer(request: Request): string | null {
  const header = request.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

export async function requireAuth(request: Request, response: Response, next: NextFunction) {
  const token = bearer(request);
  const current = token ? await readSession(token) : null;
  if (!current) return response.status(401).json({ error: "sign in required" });
  const membership = await prisma.membership.findFirst({
    where: { userId: current.userId, workspaceId: current.workspaceId, active: true },
    select: { role: true },
  });
  if (!membership) return response.status(401).json({ error: "membership ended" });
  // The stored role wins over the one in the token, so a demotion applies at once.
  response.locals.session = { ...current, role: membership.role };
  next();
}
