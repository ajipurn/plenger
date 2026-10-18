import { jwtVerify, SignJWT } from "jose";
import { config } from "../config.ts";
import { isRole, type Role } from "./roles.ts";

export interface Session {
  userId: string;
  workspaceId: string;
  role: Role;
}

const AUDIENCE = "tally-api";

export async function issueSession(session: Session): Promise<string> {
  return new SignJWT({ wid: session.workspaceId, role: session.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.userId)
    .setIssuer(config.sessionIssuer)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(config.sessionSecret);
}

export async function readSession(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, config.sessionSecret, {
      algorithms: ["HS256"],
      issuer: config.sessionIssuer,
      audience: AUDIENCE,
    });
    if (typeof payload.sub !== "string" || typeof payload.wid !== "string") return null;
    if (!isRole(payload.role)) return null;
    return { userId: payload.sub, workspaceId: payload.wid, role: payload.role };
  } catch {
    return null;
  }
}
