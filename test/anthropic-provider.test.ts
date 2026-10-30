import { describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC,
  MODEL_REQUEST_CAP,
  MODEL_RESPONSE_CAP,
  MODEL_TOOL_CALL_LIMIT,
} from "../src/redteam/constants.ts";
import {
  createRunProvider,
  type ModelRequest,
  type ReplyProgress,
  testProviderConnection,
} from "../src/redteam/provider.ts";
import { validateProviderSettings } from "../src/redteam/provider-config.ts";

const access = {
  provider: "anthropic" as const,
  model: "claude-test",
  apiKey: "local-private-key",
};
const allowance = { signal: new AbortController().signal, maxOutputTokens: 1024 };
const request: ModelRequest = { messages: [{ role: "user", content: "Hello" }], tools: null };
function message(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    role: "assistant",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "OK" }],
    usage: { input_tokens: 10, output_tokens: 3 },
    ...overrides,
  };
}

/** A Messages API event stream. */
function sse(events: unknown[]): Response {
  return new Response(
    events
      .map(
        (event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
  );
}

describe("native Anthropic transport", () => {
  it("assembles a streamed reply and reports its progress without reply text", async () => {
    const progress: ReplyProgress[] = [];
    const result = await createRunProvider(access, async () =>
      sse([
        {
          type: "message_start",
          message: message({
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 1 },
          }),
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Plan" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig" },
        },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Saving" } },
        { type: "content_block_stop", index: 1 },
        {
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use", id: "toolu_1", name: "save", input: {} },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '{"note":' },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '"Hi"}' },
        },
        { type: "content_block_stop", index: 2 },
        { type: "ping" },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
        { type: "message_stop" },
      ]),
    ).generate(request, { ...allowance, onProgress: (next) => progress.push(next) });
    expect(result.value).toEqual({
      content: "Saving",
      toolCalls: [{ id: "toolu_1", name: "save", arguments: { note: "Hi" } }],
    });
    expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 12, additionalTokens: 0 });
    expect(progress[0]).toMatchObject({ inputTokens: 15, characters: 0 });
    expect(progress.some((next) => next.thinking)).toBe(true);
    // Plan, Saving and the tool arguments: 4 + 6 + 8 + 5 characters.
    expect(progress.at(-1)).toEqual({
      characters: 23,
      thinking: false,
      tool: "save",
      inputTokens: 15,
    });
    expect(JSON.stringify(progress)).not.toMatch(/Plan|Saving|Hi/);
  });

  it.each([
    [
      "an unfinished stream",
      [{ type: "message_start", message: message({ content: [] }) }],
      "ended before completion",
    ],
    [
      "an error event",
      [{ type: "error", error: { type: "overloaded_error", message: "private-detail" } }],
      "overloaded_error",
    ],
    [
      "a delta for a block that never started",
      [
        { type: "message_start", message: message({ content: [] }) },
        { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "x" } },
      ],
      "Invalid Claude stream",
    ],
  ])("rejects %s without echoing its details", async (_label, events, reason) => {
    const failure = await createRunProvider(access, async () => sse(events))
      .generate(request, allowance)
      .catch((error: unknown) => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(reason);
    expect((failure as Error).message).not.toContain("private-detail");
  });

  it("maps system instructions and both tool formats with native headers and cached token accounting", async () => {
    const dispatch = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBe(allowance.signal);
      expect(init?.headers).toEqual({
        "Content-Type": "application/json",
        "x-api-key": access.apiKey,
        "anthropic-version": ANTHROPIC.version,
      });
      expect(JSON.parse(init?.body as string)).toEqual({
        model: access.model,
        max_tokens: 1024,
        stream: true,
        temperature: 0.2,
        system: [
          { type: "text", text: "Security policy" },
          { type: "text", text: "Application policy" },
        ],
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        tools: [
          { name: "lookup", input_schema: { type: "object" } },
          {
            name: "save",
            description: "Save a note",
            input_schema: { type: "object" },
            strict: true,
          },
        ],
      });
      return Response.json(
        message({
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "toolu_1", name: "save", input: { note: "Hello" } }],
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
            output_tokens: 3,
          },
        }),
      );
    });
    const provider = createRunProvider({ ...access, temperature: 0.2 }, dispatch);
    const input = {
      messages: [
        { role: "system", content: "Security policy" },
        { role: "developer", content: "Application policy" },
        ...request.messages,
      ],
      tools: [
        { name: "lookup", parameters: { type: "object" } },
        {
          type: "function",
          function: {
            name: "save",
            description: "Save a note",
            parameters: { type: "object" },
            strict: true,
          },
        },
      ],
    };
    expect(provider.reservation(input, "setup").inputTokensUpperBound).toBeGreaterThan(4096);
    expect(await provider.generate(input, allowance)).toEqual({
      value: {
        content: null,
        toolCalls: [{ id: "toolu_1", name: "save", arguments: { note: "Hello" } }],
      },
      usage: { inputTokens: 60, outputTokens: 3, additionalTokens: 0 },
      tokenDetails: {
        inputTokens: 10,
        outputTokens: 3,
        cacheCreationTokens: 20,
        cacheReadTokens: 30,
        cacheWrite5mTokens: null,
        cacheWrite1hTokens: null,
      },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("preserves signed thinking between parallel tool turns and groups tool results", async () => {
    const content = [
      { type: "thinking", thinking: "Internal reasoning", signature: "signed-value" },
      { type: "redacted_thinking", data: "encrypted-value" },
      { type: "text", text: "Looking up both notes." },
      { type: "tool_use", id: "toolu_1", name: "lookup", input: { id: 1 } },
      { type: "tool_use", id: "toolu_2", name: "lookup", input: { id: 2 } },
    ];
    const bodies: Record<string, unknown>[] = [];
    const provider = createRunProvider(access, async (_url, init) => {
      bodies.push(JSON.parse(init?.body as string));
      return Response.json(
        message(bodies.length === 1 ? { content, stop_reason: "tool_use" } : {}),
      );
    });
    const first = await provider.generate(request, allowance);
    await provider.generate(
      {
        messages: [
          ...request.messages,
          {
            role: "assistant",
            content: first.value.content,
            tool_calls: first.value.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          },
          { role: "tool", tool_call_id: "toolu_1", content: "First note" },
          { role: "tool", tool_call_id: "toolu_2", content: "Second note" },
        ],
        tools: null,
      },
      allowance,
    );
    expect(bodies[1]?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "First note" }],
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: [{ type: "text", text: "Second note" }],
          },
        ],
      },
    ]);
  });

  it("records refusals with usage, redacts the key, and never retries", async () => {
    const dispatch = vi.fn<typeof fetch>(async () =>
      Response.json(
        message({
          stop_reason: "refusal",
          content: [{ type: "text", text: `Declined ${access.apiKey}` }],
        }),
      ),
    );
    const reply = await createRunProvider(access, dispatch).generate(request, allowance);
    expect(reply.value).toEqual({ content: null, toolCalls: [], refusal: "Declined <redacted>" });
    expect(reply.usage).toEqual({ inputTokens: 10, outputTokens: 3, additionalTokens: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(["max_tokens", "pause_turn", "stop_sequence", "unknown"])(
    "rejects incomplete stop reason %s without retrying",
    async (stop_reason) => {
      const dispatch = vi.fn<typeof fetch>(async () => Response.json(message({ stop_reason })));
      await expect(
        createRunProvider(access, dispatch).generate(request, allowance),
      ).rejects.toThrow(`did not complete: stop reason ${stop_reason}.`);
      expect(dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it("accepts as many tool calls in one reply as the operation's bounds allow", async () => {
    const calls = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        type: "tool_use",
        id: `call-${index}`,
        name: "lookup",
        input: {},
      }));
    const reply = (count: number) =>
      vi.fn<typeof fetch>(async () =>
        Response.json(message({ stop_reason: "tool_use", content: calls(count) })),
      );
    // The managed-trial limit holds without bounds of its own.
    await expect(
      createRunProvider(access, reply(MODEL_TOOL_CALL_LIMIT + 1)).generate(request, allowance),
    ).rejects.toThrow(
      `did not complete: ${MODEL_TOOL_CALL_LIMIT + 1} tool calls in one reply, more than the ${MODEL_TOOL_CALL_LIMIT} accepted.`,
    );
    const bounded = {
      ...access,
      requestBounds: { bytes: MODEL_REQUEST_CAP, inputTokensPerByte: 4, toolCalls: 16 },
    };
    const result = await createRunProvider(bounded, reply(16)).generate(request, allowance);
    expect(result.value.toolCalls).toHaveLength(16);
    await expect(
      createRunProvider(bounded, reply(17)).generate(request, allowance),
    ).rejects.toThrow("17 tool calls in one reply, more than the 16 accepted.");
  });

  it.each([
    { usage: undefined },
    { usage: { input_tokens: 1, output_tokens: -1 } },
    { usage: { input_tokens: 1.5, output_tokens: 1 } },
    { usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: -2 } },
    { usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 } },
    {
      content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: [] }],
      stop_reason: "tool_use",
    },
    { content: [{ type: "server_tool_use", name: "web_search" }] },
  ])("rejects malformed usage or unsupported content (%j)", async (override) => {
    await expect(
      createRunProvider(access, async () => Response.json(message(override))).generate(
        request,
        allowance,
      ),
    ).rejects.toThrow();
  });

  it("bounds requests and responses, and hides error bodies", async () => {
    const dispatch = vi.fn<typeof fetch>(
      async () => new Response("secret-provider-error", { status: 403 }),
    );
    await expect(createRunProvider(access, dispatch).generate(request, allowance)).rejects.toThrow(
      "HTTP 403",
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    const tooLarge = {
      ...request,
      messages: [{ role: "user", content: "x".repeat(MODEL_REQUEST_CAP) }],
    };
    expect(() => createRunProvider(access, dispatch).reservation(tooLarge, "setup")).toThrow(
      "size limit",
    );
    await expect(createRunProvider(access, dispatch).generate(tooLarge, allowance)).rejects.toThrow(
      "size limit",
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    await expect(
      createRunProvider(
        access,
        async () => new Response("x".repeat(MODEL_RESPONSE_CAP + 1)),
      ).generate(request, allowance),
    ).rejects.toThrow("size limit");
    await expect(
      createRunProvider(access, async () => new Response("not JSON")).generate(request, allowance),
    ).rejects.toThrow("invalid JSON");
  });

  it("requires a key, validates temperature, and uses the native connection test", async () => {
    expect(() => createRunProvider({ provider: "anthropic", model: access.model })).toThrow(
      "API key",
    );
    expect(() => validateProviderSettings({ ...access, temperature: 1.1 })).toThrow("0 to 1");
    const dispatch = vi.fn<typeof fetch>(async () => Response.json(message()));
    expect(await testProviderConnection(access, dispatch)).toMatchObject({ model: access.model });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
