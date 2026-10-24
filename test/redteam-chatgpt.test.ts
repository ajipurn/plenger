import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API, type ChatgptLoginResult, TOKEN_HEADER } from "../src/dashboard/contract.ts";
import { ModelBudget } from "../src/redteam/budget.ts";
import { chatgptModels } from "../src/redteam/chatgpt-auth.ts";
import { CHATGPT, MAX_OUTPUT_TOKENS, MODEL_RESPONSE_CAP } from "../src/redteam/constants.ts";
import {
  createRunProvider,
  type ModelRequest,
  reachedOutputLimit,
} from "../src/redteam/provider.ts";
import { PROVIDER_URLS, type SavedProvider } from "../src/redteam/provider-config.ts";
import { ProviderRepository } from "../src/storage/provider-repository.ts";
import { required, startTestDashboard } from "./support/dashboard.ts";
import { temporaryDir } from "./support/tmp.ts";

const actualFetch = globalThis.fetch;
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = {
  ...keys.publicKey.export({ format: "jwk" }),
  kid: "test-key",
  use: "sig",
  alg: "RS256",
};
const request: ModelRequest = {
  messages: [
    { role: "system", content: "Only write to the approved path." },
    { role: "user", content: "Save this text." },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "save",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
  ],
};

function stream(
  output: unknown[] = [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
  outputTokens = 3,
): Response {
  return new Response(
    `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, usage: { input_tokens: 10, output_tokens: outputTokens, total_tokens: 10 + outputTokens } } })}\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

async function loginHarness(
  options: {
    claims?: Record<string, unknown>;
    scope?: string;
    expiresIn?: number;
    invalidSignature?: boolean;
    wrongStateFirst?: boolean;
    denied?: boolean;
    tokenFailure?: boolean;
    tokenNetworkFailure?: boolean;
    tokenInvalidJson?: boolean;
  } = {},
) {
  const root = await temporaryDir("plenger-chatgpt-");
  const authUrls: URL[] = [];
  const modelRequests: { body: Record<string, unknown>; authorization: string | null }[] = [];
  const tokenBodies: URLSearchParams[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) return actualFetch(input, init);
    if (url === CHATGPT.token) {
      const body = new URLSearchParams(String(init?.body));
      tokenBodies.push(body);
      if (options.tokenNetworkFailure)
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("private-network-details"), { code: "ECONNRESET" }),
        });
      if (options.tokenInvalidJson) return new Response("private-invalid-json", { status: 200 });
      if (options.tokenFailure) return new Response("secret-provider-error-body", { status: 400 });
      if (body.get("grant_type") === "refresh_token") {
        expect(body.get("refresh_token")).toBe("private-refresh-token");
        await new Promise((resolve) => setTimeout(resolve, 20));
        return Response.json({
          access_token: "rotated-access-token",
          refresh_token: "rotated-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      const auth = required(authUrls.at(-1), "authorization");
      expect(
        createHash("sha256")
          .update(body.get("code_verifier") ?? "")
          .digest("base64url"),
      ).toBe(auth.searchParams.get("code_challenge"));
      expect(body.get("redirect_uri")).toBe(auth.searchParams.get("redirect_uri"));
      expect(body.get("client_id")).toBe("oaiapp_plenger_test");
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString(
        "base64url",
      );
      const claims = Buffer.from(
        JSON.stringify({
          iss: CHATGPT.issuer,
          sub: "test-user",
          email: "test@example.com",
          aud: "oaiapp_plenger_test",
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
          nonce: auth.searchParams.get("nonce"),
          ...options.claims,
        }),
      ).toString("base64url");
      const signature = options.invalidSignature
        ? "invalid"
        : sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), keys.privateKey).toString(
            "base64url",
          );
      return Response.json({
        access_token: "private-access-token",
        refresh_token: "private-refresh-token",
        id_token: `${header}.${claims}.${signature}`,
        token_type: "Bearer",
        expires_in: options.expiresIn ?? 3600,
        scope: options.scope ?? CHATGPT.scope,
      });
    }
    if (url === CHATGPT.jwks) return Response.json({ keys: [jwk] });
    if (url === `${CHATGPT.resource}/models`)
      return Response.json({
        models: [
          { slug: "hidden-model", display_name: "Hidden", visibility: "hidden" },
          { slug: "test-model", display_name: "Test model", visibility: "list" },
        ],
      });
    if (url === `${CHATGPT.resource}/responses`) {
      modelRequests.push({
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      return stream();
    }
    throw new Error(`Unexpected test fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  async function login() {
    const store = await ProviderRepository.open(root);
    const previous = store.providers
      .readProviders()
      .find((item) => item.name === "My subscription");
    store.close();
    const dashboard = await startTestDashboard({ root: join(root, "login"), dataDir: root });
    try {
      const started = (await (
        await dashboard.request(API.chatgptLogin, {
          ...(previous ? { id: previous.id } : {}),
          name: "My subscription",
          provider: "chatgpt",
          model: "pending-sign-in",
          baseUrl: PROVIDER_URLS.chatgpt,
          temperature: null,
          maxOutputTokens: 1024,
        })
      ).json()) as ChatgptLoginResult;
      const auth = new URL(required(started.authorizationUrl, "authorization URL"));
      authUrls.push(auth);
      const target = new URL(required(auth.searchParams.get("redirect_uri"), "callback"));
      target.searchParams.set("state", required(auth.searchParams.get("state"), "state"));
      target.searchParams.set("client_id", "oaiapp_plenger_test");
      target.searchParams.set(
        options.denied ? "error" : "code",
        options.denied ? "access_denied" : "test-code",
      );
      if (options.wrongStateFirst) {
        const bad = new URL(target);
        bad.searchParams.set("state", "wrong");
        expect((await actualFetch(bad)).status).toBe(400);
      }
      expect((await actualFetch(target)).status).toBe(200);
      let result = started;
      await vi.waitFor(async () => {
        result = (await (
          await dashboard.request(`${API.chatgptLoginStatus}?id=${started.id}`)
        ).json()) as ChatgptLoginResult;
        expect(result.state).not.toBe("pending");
      });
      return { code: result.state === "connected" ? 0 : 1, stdout: "", stderr: result.error ?? "" };
    } finally {
      await dashboard.close();
    }
  }
  return { root, login, authUrls, modelRequests, tokenBodies, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatGPT subscription login", () => {
  it("signs in from the dashboard and returns models without credentials", async () => {
    const harness = await loginHarness();
    const dashboard = await startTestDashboard({ root: harness.root });
    try {
      const input = {
        baseUrl: PROVIDER_URLS.chatgpt,
        temperature: null,
        name: "Dashboard ChatGPT",
        provider: "chatgpt",
        model: "pending-sign-in",
        maxOutputTokens: 1024,
      };
      expect(
        (await dashboard.request(API.chatgptLogin, input, { [TOKEN_HEADER]: "wrong" })).status,
      ).toBe(403);
      const response = await dashboard.request(API.chatgptLogin, input);
      expect(response.status).toBe(200);
      const started = (await response.json()) as ChatgptLoginResult;
      expect(started.state).toBe("pending");
      expect((await dashboard.request(API.chatgptLogin, input)).status).toBe(409);
      const auth = new URL(required(started.authorizationUrl, "authorization URL"));
      harness.authUrls.push(auth);
      const callback = new URL(required(auth.searchParams.get("redirect_uri"), "callback"));
      callback.searchParams.set("state", required(auth.searchParams.get("state"), "state"));
      callback.searchParams.set("client_id", "oaiapp_plenger_test");
      callback.searchParams.set("code", "test-code");
      expect((await actualFetch(callback)).status).toBe(200);
      let result: ChatgptLoginResult = started;
      await vi.waitFor(async () => {
        result = (await (
          await dashboard.request(`${API.chatgptLoginStatus}?id=${started.id}`)
        ).json()) as ChatgptLoginResult;
        expect(result.state).toBe("connected");
      });
      expect(result.provider).toMatchObject({
        model: "test-model",
        chatgptAccount: "t•••@example.com",
      });
      expect(result.models).toEqual([{ id: "test-model", name: "Test model" }]);
      expect(result.authorizationUrl).toBeUndefined();
      expect(JSON.stringify(result)).not.toMatch(/private-|accessToken|refreshToken|idToken/);
    } finally {
      await dashboard.close();
    }
  });

  it("reports token exchange failures in the dashboard without exposing response bodies", async () => {
    const harness = await loginHarness({ tokenFailure: true });
    const dashboard = await startTestDashboard({ root: harness.root });
    try {
      const started = (await (
        await dashboard.request(API.chatgptLogin, {
          name: "Failed login",
          provider: "chatgpt",
          model: "pending-sign-in",
          baseUrl: PROVIDER_URLS.chatgpt,
          temperature: null,
          maxOutputTokens: 1024,
        })
      ).json()) as ChatgptLoginResult;
      const auth = new URL(required(started.authorizationUrl, "authorization URL"));
      const callback = new URL(required(auth.searchParams.get("redirect_uri"), "callback"));
      callback.searchParams.set("state", required(auth.searchParams.get("state"), "state"));
      callback.searchParams.set("client_id", "oaiapp_plenger_test");
      callback.searchParams.set("code", "test-code");
      await actualFetch(callback);
      await vi.waitFor(async () => {
        const result = (await (
          await dashboard.request(`${API.chatgptLoginStatus}?id=${started.id}`)
        ).json()) as ChatgptLoginResult;
        expect(result.state).toBe("failed");
        expect(result.error).toContain("token exchange (HTTP 400)");
        expect(JSON.stringify(result)).not.toMatch(/private-|secret-provider-error-body/);
      });
    } finally {
      await dashboard.close();
    }
  });

  it("cancels dashboard login and closes its callback on shutdown", async () => {
    const harness = await loginHarness();
    const dashboard = await startTestDashboard({ root: harness.root });
    const input = {
      baseUrl: PROVIDER_URLS.chatgpt,
      temperature: null,
      name: "Dashboard ChatGPT",
      provider: "chatgpt",
      model: "pending-sign-in",
      maxOutputTokens: 1024,
    };
    try {
      const started = (await (
        await dashboard.request(API.chatgptLogin, input)
      ).json()) as ChatgptLoginResult;
      const cancelled = (await (
        await dashboard.request(API.cancelChatgptLogin, { id: started.id })
      ).json()) as ChatgptLoginResult;
      expect(cancelled.state).toBe("cancelled");
      const next = (await (
        await dashboard.request(API.chatgptLogin, { ...input, id: started.provider.id })
      ).json()) as ChatgptLoginResult;
      const auth = new URL(required(next.authorizationUrl, "authorization URL"));
      await dashboard.close();
      await expect(
        actualFetch(required(auth.searchParams.get("redirect_uri"), "callback")),
      ).rejects.toThrow();
    } finally {
      await dashboard.close();
    }
  });

  it("registers with PKCE, stores encrypted credentials and shares a provider with the dashboard", async () => {
    const harness = await loginHarness({ wrongStateFirst: true });
    expect(await harness.login()).toMatchObject({ code: 0, stderr: "" });
    const store = await ProviderRepository.open(harness.root);
    const saved = required(store.providers.readProviders()[0], "provider");
    expect(saved).toMatchObject({
      provider: "chatgpt",
      model: "test-model",
      hasApiKey: false,
      chatgptAccount: "t•••@example.com",
    });
    const access = store.providers.resolveProvider(saved.id).access;
    store.close();
    const provider = createRunProvider(access);
    expect(
      await provider.generate(request, {
        signal: new AbortController().signal,
        maxOutputTokens: 30,
      }),
    ).toMatchObject({ value: { content: "OK" }, usage: { inputTokens: 10, outputTokens: 3 } });
    expect(harness.modelRequests[0]?.authorization).toBe("Bearer private-access-token");
    const body = required(harness.modelRequests[0], "request").body;
    expect(body).toMatchObject({
      store: false,
      stream: true,
      input: [
        { role: "developer", content: "Only write to the approved path." },
        { role: "user", content: "Save this text." },
      ],
      tools: [{ type: "namespace", name: "plenger" }],
    });
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("temperature");
    const dashboard = await startTestDashboard({
      root: join(harness.root, "dashboard"),
      dataDir: harness.root,
    });
    try {
      const listing = await (
        await actualFetch(`${dashboard.url}${API.providers}`, {
          headers: { "X-Plenger-Token": dashboard.session.token },
        })
      ).text();
      expect(listing).not.toContain("private-");
      expect(listing).not.toContain("idToken");
      expect(listing).toContain("chatgpt");
    } finally {
      await dashboard.close();
    }
    expect(
      (await readFile(join(harness.root, "dashboard.sqlite"))).includes(
        Buffer.from("private-access-token"),
      ),
    ).toBe(false);
    expect(await harness.login()).toMatchObject({ code: 0 });
    expect(harness.authUrls[0]?.searchParams.get("client_id")).toBe(CHATGPT.dynamicClient);
    expect(harness.authUrls[1]?.searchParams.get("client_id")).toBe("oaiapp_plenger_test");
    expect(harness.authUrls[1]?.searchParams.get("agent_name_hint")).toBeNull();
    expect(harness.authUrls[1]?.searchParams.get("ext_agent_host_id")).toBe(
      harness.authUrls[0]?.searchParams.get("ext_agent_host_id"),
    );
  });

  it.each([
    { claims: { nonce: "wrong" } },
    { claims: { iss: "https://example.com" } },
    { claims: { aud: "another-client" } },
    { claims: { exp: 1 } },
    { invalidSignature: true },
    { scope: "openid profile email" },
    { denied: true },
  ])("rejects invalid identity or missing consent: %j", async (options) => {
    const harness = await loginHarness(options);
    const result = await harness.login();
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("private-");
    const store = await ProviderRepository.open(harness.root);
    try {
      const saved = required(store.providers.readProviders()[0], "provider");
      expect(store.providers.readChatgptSession(saved.id).session.credentials).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it.each([
    { options: { tokenNetworkFailure: true }, message: "connection failed (ECONNRESET)" },
    { options: { tokenInvalidJson: true }, message: "returned invalid JSON (HTTP 200)" },
  ])("distinguishes safe token diagnostics: $message", async ({ options, message }) => {
    const harness = await loginHarness(options);
    const result = await harness.login();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain("private-");
  });

  it("retains an issued registration when token exchange fails", async () => {
    const harness = await loginHarness({ tokenFailure: true });
    expect((await harness.login()).code).toBe(1);
    expect((await harness.login()).stderr).not.toContain("secret-provider-error-body");
    expect(harness.authUrls[1]?.searchParams.get("client_id")).toBe("oaiapp_plenger_test");
  });

  it("keeps the signed-in model list across edits until the account signs out", async () => {
    const harness = await loginHarness();
    expect((await harness.login()).code).toBe(0);
    const models = [{ id: "test-model", name: "Test model" }];
    const dashboard = await startTestDashboard({
      root: join(harness.root, "dashboard"),
      dataDir: harness.root,
    });
    let id = "";
    try {
      const [saved] = (await (await dashboard.request(API.providers)).json()) as SavedProvider[];
      id = required(saved, "provider").id;
      expect(saved).toMatchObject({ chatgptModels: models });
      // Automatic output settings follow the model's defaults.
      const edited = await dashboard.request(API.providers, {
        id,
        name: "My subscription",
        provider: "chatgpt",
        model: "test-model",
        baseUrl: PROVIDER_URLS.chatgpt,
        temperature: null,
        maxOutputTokens: null,
      });
      expect(edited.status).toBe(200);
      expect(await edited.json()).toMatchObject({ maxOutputTokens: null, chatgptModels: models });
    } finally {
      await dashboard.close();
    }
    const store = await ProviderRepository.open(harness.root);
    try {
      const { session, sealed } = store.providers.readChatgptSession(id);
      store.providers.saveChatgptSession(id, { clientId: session.clientId }, sealed);
      expect(store.providers.readProviders()[0]).not.toHaveProperty("chatgptModels");
    } finally {
      store.close();
    }
  });

  it("serializes token rotation across separately opened repositories", async () => {
    const harness = await loginHarness({ expiresIn: 30 });
    expect((await harness.login()).code).toBe(0);
    const stores = await Promise.all([
      ProviderRepository.open(harness.root),
      ProviderRepository.open(harness.root),
    ]);
    const resolvers = stores.map((store) => {
      const saved = required(store.providers.readProviders()[0], "provider");
      const resolver = required(
        store.providers.resolveProvider(saved.id).access.accessToken,
        "token resolver",
      );
      store.close();
      return resolver;
    });
    expect(
      await Promise.all(resolvers.map((resolve) => resolve(new AbortController().signal))),
    ).toEqual(["rotated-access-token", "rotated-access-token"]);
    expect(
      harness.tokenBodies.filter((body) => body.get("grant_type") === "refresh_token"),
    ).toHaveLength(1);
  });
});

describe("ChatGPT streaming provider", () => {
  function provider(dispatch: typeof fetch) {
    return createRunProvider(
      {
        provider: "chatgpt",
        model: "test-model",
        maxOutputTokens: 30,
        accessToken: async () => "test-access",
      },
      dispatch,
    );
  }
  const allowance = () => ({ signal: new AbortController().signal, maxOutputTokens: 30 });

  it("preserves encrypted reasoning and tool calls across turns without persisting them", async () => {
    const output = [
      { type: "reasoning", encrypted_content: "opaque-reasoning" },
      {
        type: "function_call",
        call_id: "call-1",
        namespace: "plenger",
        name: "save",
        arguments: '{"path":"allowed"}',
      },
    ];
    const sent: Record<string, unknown>[] = [];
    const model = provider(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return sent.length === 1 ? stream(output) : stream();
    });
    const first = await model.generate(request, allowance());
    expect(first.value.toolCalls).toEqual([
      { id: "call-1", name: "save", arguments: { path: "allowed" } },
    ]);
    expect(JSON.stringify(first)).not.toContain("opaque-reasoning");
    await model.generate(
      {
        ...request,
        messages: [
          ...request.messages,
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "save", arguments: '{"path":"allowed"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call-1", content: "saved" },
        ],
      },
      allowance(),
    );
    expect(sent[1]?.input).toEqual([
      { role: "developer", content: "Only write to the approved path." },
      { role: "user", content: "Save this text." },
      ...output,
      { type: "function_call_output", call_id: "call-1", output: "saved" },
    ]);
  });

  it.each([
    "data: [DONE]\n\n",
    'data: {"type":"response.failed","response":{"error":{"message":"private-error"}}}\n\n',
    'data: {"type":"response.incomplete"}\n\n',
    'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
    `data: ${"x".repeat(MODEL_RESPONSE_CAP)}\n\n`,
    "data: invalid-json\n\n",
  ])("rejects failed, missing or malformed completion streams", async (body) => {
    await expect(
      provider(async () => new Response(body)).generate(request, allowance()),
    ).rejects.toThrow();
  });

  it("marks a response cut at its output allowance as an output limit", async () => {
    const cut = provider(
      async () =>
        new Response(
          'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
        ),
    ).generate(request, allowance());
    const error = await cut.catch((failure: unknown) => failure);
    expect(reachedOutputLimit(error)).toBe(true);
    const other = await provider(
      async () => new Response('data: {"type":"response.incomplete"}\n\n'),
    )
      .generate(request, allowance())
      .catch((failure: unknown) => failure);
    expect(reachedOutputLimit(other)).toBe(false);
  });

  it("retains completed output items when the completion event has an empty output", async () => {
    const item = { type: "message", content: [{ type: "output_text", text: "OK" }] };
    const events = [
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [],
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
        },
      },
    ];
    const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    const result = await provider(async () => new Response(body)).generate(request, allowance());
    expect(result.value.content).toBe("OK");
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 1 });
  });

  it("handles split UTF-8 and CRLF events", async () => {
    const text = (
      await stream([
        { type: "message", content: [{ type: "output_text", text: "完成 😊" }] },
      ]).text()
    ).replaceAll("\n", "\r\n");
    const bytes = Buffer.from(text);
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
    );
    expect(
      (await provider(async () => response).generate(request, allowance())).value.content,
    ).toBe("完成 😊");
  });

  it("reserves the operation's allowance when the output limit is automatic", () => {
    const automatic = (outputTokenBudget?: number) =>
      createRunProvider({
        provider: "chatgpt",
        model: "test-model",
        maxOutputTokens: null,
        accessToken: async () => "test-access",
        ...(outputTokenBudget === undefined ? {} : { outputTokenBudget }),
      }).reservation(request, "probe").maxOutputTokens;
    expect(automatic()).toBe(MAX_OUTPUT_TOKENS);
    expect(automatic(2048)).toBe(2048);
  });

  it("records observed thresholds and rejects a response that overruns its reservation", async () => {
    const model = provider(async () => stream(undefined, 31));
    const budget = new ModelBudget({ maxModelCalls: 1, maxTokens: 100_000, timeoutMs: 1000 });
    try {
      await expect(
        budget.execute(model.reservation(request, "probe"), (allowance) =>
          model.generate(request, allowance),
        ),
      ).rejects.toMatchObject({ reason: "provider-usage-exceeded-reservation" });
      expect(budget.snapshot()).toMatchObject({
        tokenLimitMode: "observed",
        observedTokens: 41,
        state: "stopped",
      });
    } finally {
      budget.finish();
    }
  });

  it("does not accept API keys or alternate endpoints as subscription access", () => {
    expect(() =>
      createRunProvider({ provider: "chatgpt", model: "test", apiKey: "not-oauth" }),
    ).toThrow(/browser sign-in/);
    expect(() =>
      createRunProvider({ provider: "chatgpt", model: "test", baseUrl: "https://example.com" }),
    ).toThrow(/fixed endpoint/);
    expect(() => createRunProvider({ provider: "chatgpt", model: "test" })).toThrow(
      /Settings > Providers/,
    );
  });
});

describe("ChatGPT model catalog size", () => {
  it("still rejects catalogs exceeding the dedicated limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(CHATGPT.modelCatalogByteCap + 1))),
    );
    await expect(chatgptModels("test-token", new AbortController().signal)).rejects.toThrow(
      "model discovery response exceeded the size limit",
    );
  });
  it("accepts catalog metadata larger than an inference response", async () => {
    const catalog = {
      models: [
        {
          slug: "test-model",
          display_name: "Test model",
          visibility: "list",
          metadata: "x".repeat(MODEL_RESPONSE_CAP * 2),
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(catalog)),
    );
    await expect(chatgptModels("test-token", new AbortController().signal)).resolves.toEqual([
      { id: "test-model", name: "Test model" },
    ]);
  });
});
