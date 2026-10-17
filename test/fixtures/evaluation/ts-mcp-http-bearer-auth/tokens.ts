import { createHash, timingSafeEqual } from "node:crypto";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";

const configured = process.env.OPS_MCP_TOKEN ?? "";
const expected = createHash("sha256").update(configured).digest();

/** Accepts only the operator token configured for this deployment. */
export const verifier: OAuthTokenVerifier = {
  async verifyAccessToken(token) {
    const given = createHash("sha256").update(token).digest();
    if (configured === "" || !timingSafeEqual(given, expected)) throw new Error("invalid token");
    return { token, clientId: "operator", scopes: ["ops"], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  },
};
