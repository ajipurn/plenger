import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { createServer } from "node:http";
import { CHATGPT, MODEL_RESPONSE_CAP } from "./constants.ts";
import { record } from "./provider.ts";

/** Only locally authored messages, safe to display without OAuth response bodies. */
export class ChatgptAuthError extends Error {}

export interface ChatgptSession {
  clientId: string;
  subject?: string;
  email?: string;
  credentials?: {
    accessToken: string;
    refreshToken: string;
    idToken: string;
    expiresAt: number;
    scopes: string[];
  };
}

/** A public OAuth client with PKCE. The caller owns protected credential storage. */
export async function signInChatgpt(options: {
  hostId: string;
  previous?: ChatgptSession;
  signal: AbortSignal;
  onAuthorize: (url: string) => void;
  onRegistration: (session: ChatgptSession) => Promise<void>;
}): Promise<ChatgptSession> {
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(CHATGPT.loginTimeoutMs)]);
  let finish: (value: URL) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const callback = new Promise<URL>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // The promise can reject during listener setup, before the main await.
  void callback.catch(() => {});
  let received = false,
    redirectUri = "";
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Referrer-Policy", "no-referrer");
    let url: URL;
    try {
      url = new URL(request.url ?? "/", redirectUri);
    } catch {
      response.writeHead(400).end("Invalid sign-in callback.");
      return;
    }
    if (
      request.method !== "GET" ||
      request.headers.host !== new URL(redirectUri).host ||
      url.pathname !== CHATGPT.callbackPath ||
      url.searchParams.get("state") !== state ||
      received
    ) {
      response.writeHead(400).end("Invalid sign-in callback.");
      return;
    }
    received = true;
    response.end(
      "Authorization received. Plenger is still checking your account and model access. Return to Plenger for the result. You can close this tab.",
    );
    finish(url);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  const aborted = () => fail(new ChatgptAuthError("ChatGPT sign-in was cancelled or timed out."));
  signal.addEventListener("abort", aborted, { once: true });
  try {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new ChatgptAuthError("Could not start the ChatGPT sign-in callback.");
    redirectUri = `http://127.0.0.1:${address.port}${CHATGPT.callbackPath}`;
    const authorize = new URL(CHATGPT.authorize);
    authorize.search = new URLSearchParams({
      client_id: options.previous?.clientId ?? CHATGPT.dynamicClient,
      ...(options.previous ? {} : { agent_name_hint: "Plenger" }),
      ext_agent_host_id: options.hostId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: CHATGPT.scope,
      resource: CHATGPT.resource,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    options.onAuthorize(authorize.href);
    const returned = await callback;
    if (returned.searchParams.has("error"))
      throw new ChatgptAuthError(
        "ChatGPT sign-in was declined. Enable ChatGPT plan usage when signing in.",
      );
    const code = returned.searchParams.get("code");
    const clientId = returned.searchParams.get("client_id") ?? options.previous?.clientId;
    if (
      !code ||
      !clientId ||
      clientId === CHATGPT.dynamicClient ||
      (options.previous && clientId !== options.previous.clientId)
    )
      throw new ChatgptAuthError("Invalid ChatGPT registration callback.");
    const registration = options.previous ?? { clientId };
    await options.onRegistration(registration);
    const token = await tokenRequest(
      {
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: CHATGPT.resource,
      },
      signal,
    );
    const identity = await verifyIdentity(token.id_token, clientId, signal, nonce);
    if (options.previous?.subject && options.previous.subject !== identity.sub)
      throw new ChatgptAuthError(
        "ChatGPT account changed. Create a separate provider for another account.",
      );
    return sessionFromToken(registration, token, identity);
  } finally {
    signal.removeEventListener("abort", aborted);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export async function refreshChatgpt(
  session: ChatgptSession,
  signal: AbortSignal,
): Promise<ChatgptSession> {
  if (!session.credentials)
    throw new ChatgptAuthError("Sign in with plenger redteam login --provider <name> first.");
  const token = await tokenRequest(
    {
      grant_type: "refresh_token",
      client_id: session.clientId,
      refresh_token: session.credentials.refreshToken,
      resource: CHATGPT.resource,
    },
    signal,
  );
  const identity =
    token.id_token === undefined
      ? { sub: session.subject, email: session.email }
      : await verifyIdentity(token.id_token, session.clientId, signal);
  if (identity.sub !== session.subject)
    throw new ChatgptAuthError("ChatGPT account changed. Sign in again.");
  return sessionFromToken(session, token, identity);
}

export async function chatgptModels(
  accessToken: string,
  signal: AbortSignal,
): Promise<{ id: string; name: string }[]> {
  const result = await authJson(
    `${CHATGPT.resource}/models`,
    { headers: { Authorization: `Bearer ${accessToken}` }, signal },
    CHATGPT.modelCatalogByteCap,
  );
  if (!Array.isArray(result.models))
    throw new ChatgptAuthError("ChatGPT returned an invalid model catalog.");
  return result.models
    .map(record)
    .filter(
      (item) =>
        item.visibility === "list" &&
        typeof item.slug === "string" &&
        typeof item.display_name === "string",
    )
    .map((item) => ({ id: item.slug as string, name: item.display_name as string }));
}

async function tokenRequest(body: Record<string, string>, signal: AbortSignal) {
  return authJson(CHATGPT.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal,
  });
}

async function authJson(
  url: string,
  init: RequestInit,
  byteCap = MODEL_RESPONSE_CAP,
): Promise<Record<string, unknown>> {
  const stage =
    url === CHATGPT.token
      ? "token exchange"
      : url === CHATGPT.jwks
        ? "identity key retrieval"
        : "model discovery";
  const signal = AbortSignal.any([
    ...(init.signal ? [init.signal] : []),
    AbortSignal.timeout(CHATGPT.requestTimeoutMs),
  ]);
  try {
    const response = await fetch(url, { ...init, signal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ChatgptAuthError(
        `ChatGPT ${stage} (HTTP ${response.status}) failed. Try signing in again. If it persists, check account access and the integration configuration.`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ChatgptAuthError(`ChatGPT ${stage} returned an empty response.`);
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > byteCap)
          throw new ChatgptAuthError(`ChatGPT ${stage} response exceeded the size limit.`);
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    try {
      return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      throw new ChatgptAuthError(
        `ChatGPT ${stage} returned invalid JSON (HTTP ${response.status}).`,
      );
    }
  } catch (error) {
    if (error instanceof ChatgptAuthError) throw error;
    if (signal.aborted)
      throw new ChatgptAuthError(
        `ChatGPT ${stage} was cancelled or timed out. Start sign-in again.`,
      );
    const cause = error instanceof Error ? error.cause : undefined;
    const code = record(cause).code;
    const knownCode =
      typeof code === "string" &&
      [
        "ENOTFOUND",
        "EAI_AGAIN",
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_SOCKET",
        "CERT_HAS_EXPIRED",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
      ].includes(code)
        ? ` (${code})`
        : "";
    throw new ChatgptAuthError(
      `ChatGPT ${stage} connection failed${knownCode}. Check the dashboard server's network connection and try again.`,
    );
  }
}

async function verifyIdentity(
  token: unknown,
  clientId: string,
  signal: AbortSignal,
  nonce?: string,
): Promise<Record<string, unknown>> {
  try {
    if (typeof token !== "string") throw new Error();
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error();
    const header = record(
      JSON.parse(Buffer.from(parts[0] as string, "base64url").toString("utf8")),
    );
    const claims = record(
      JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8")),
    );
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error();
    const jwks = await authJson(CHATGPT.jwks, { signal });
    if (!Array.isArray(jwks.keys)) throw new Error();
    const key = jwks.keys
      .map(record)
      .find(
        (key) =>
          key.kid === header.kid &&
          key.kty === "RSA" &&
          (key.use === undefined || key.use === "sig") &&
          (key.alg === undefined || key.alg === "RS256"),
      );
    if (
      !key ||
      !verify(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        createPublicKey({ key, format: "jwk" }),
        Buffer.from(parts[2] as string, "base64url"),
      )
    )
      throw new Error();
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const now = Date.now() / 1000;
    if (
      claims.iss !== CHATGPT.issuer ||
      !audience.includes(clientId) ||
      (audience.length > 1 && claims.azp !== clientId) ||
      (claims.azp !== undefined && claims.azp !== clientId) ||
      typeof claims.sub !== "string" ||
      !claims.sub ||
      typeof claims.exp !== "number" ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= now ||
      typeof claims.iat !== "number" ||
      !Number.isFinite(claims.iat) ||
      claims.iat > now + 5 ||
      (claims.nbf !== undefined &&
        (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > now + 5)) ||
      (nonce !== undefined && claims.nonce !== nonce)
    )
      throw new Error();
    return claims;
  } catch (error) {
    if (error instanceof ChatgptAuthError) throw error;
    throw new ChatgptAuthError("ChatGPT identity verification failed. Sign in again.");
  }
}

function sessionFromToken(
  previous: ChatgptSession,
  token: Record<string, unknown>,
  identity: Record<string, unknown>,
): ChatgptSession {
  const scopes =
    typeof token.scope === "string" ? token.scope.split(/\s+/) : previous.credentials?.scopes;
  const refreshToken = token.refresh_token ?? previous.credentials?.refreshToken;
  const idToken = token.id_token ?? previous.credentials?.idToken;
  if (!scopes?.includes("chatgpt.tokens.use.direct") || !scopes.includes("resource.invoke"))
    throw new ChatgptAuthError("Enable ChatGPT plan usage when signing in.");
  if (
    typeof token.access_token !== "string" ||
    !token.access_token ||
    typeof refreshToken !== "string" ||
    !refreshToken ||
    typeof idToken !== "string" ||
    typeof token.token_type !== "string" ||
    token.token_type.toLowerCase() !== "bearer" ||
    !Number.isSafeInteger(token.expires_in) ||
    (token.expires_in as number) <= 0 ||
    typeof identity.sub !== "string"
  )
    throw new ChatgptAuthError("Invalid ChatGPT credential response. Sign in again.");
  return {
    clientId: previous.clientId,
    subject: identity.sub,
    ...(typeof identity.email === "string" ? { email: identity.email } : {}),
    credentials: {
      accessToken: token.access_token,
      refreshToken,
      idToken,
      scopes,
      expiresAt: Date.now() + (token.expires_in as number) * 1000,
    },
  };
}
