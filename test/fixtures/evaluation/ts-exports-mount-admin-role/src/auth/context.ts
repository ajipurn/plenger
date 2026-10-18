import type { Response } from "express";
import type { Session } from "./session.ts";

/** The session `requireAuth` stored for this request. */
export function session(response: Response): Session {
  const current = response.locals.session as Session | undefined;
  if (!current) throw new Error("route mounted without requireAuth");
  return current;
}
