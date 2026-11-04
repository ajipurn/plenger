import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCampaignPlan, executeCampaign, newCampaign } from "../src/redteam/campaign.ts";
import { WORKER_PROTOCOL_VERSION } from "../src/redteam/constants.ts";
import { planProject } from "../src/redteam/plan.ts";
import {
  createRunProvider,
  ModelProviderHttpError,
  normalizeTools,
  parseModelReply,
  type ReplyProgress,
  reachedOutputLimit,
} from "../src/redteam/provider.ts";
import { executeRun, newRun, type RunOptions } from "../src/redteam/run.ts";
import { assertReadyFrame } from "../src/redteam/run-lifecycle.ts";
import * as runtime from "../src/redteam/runtime.ts";
import * as workers from "../src/redteam/worker.ts";
import { WorkerError, type WorkerLauncher } from "../src/redteam/worker.ts";
import { stubProvider, toolCallReply } from "./support/provider.ts";
import { temporaryDir } from "./support/tmp.ts";

async function project() {
  const root = await temporaryDir("plenger-run-");
  await writeFile(join(root, "requirements.txt"), "llmfy==0.11.0\n");
  await writeFile(
    join(root, "agent.py"),
    `from pathlib import Path
from llmfy import LLMfy, OpenAIChatModel, Tool
@Tool()
def save(path: str, text: str) -> str:
    Path(path).write_text(text)
    return "saved"
def build_agent():
    agent = LLMfy(OpenAIChatModel(model="test"))
    agent.register_tool([save])
    return agent
`,
  );
  const plan = await planProject(root);
  const provider = stubProvider({
    generate: {
      value: toolCallReply("save"),
      usage: { inputTokens: 5, outputTokens: 5, additionalTokens: 0 },
    },
  });
  const options: RunOptions = {
    target: plan.selectedTarget as string,
    sourceDigest: plan.sourceDigest,
    provider,
    limits: { maxModelCalls: 6, maxTokens: 1000, timeoutMs: 10_000 },
  };
  return { root, options };
}

const checks = [
  "linux",
  "python-version",
  "non-root",
  "no-capabilities",
  "no-new-privileges",
  "seccomp-filter",
  "loopback-only",
  "read-only-root",
  "private-temporary-files",
  "memory-limit",
  "no-swap",
  "process-limit",
  "cpu-limit",
  "no-host-file",
  "no-host-environment",
  "no-container-socket",
  "image-write-denied",
  "temporary-write",
];
function worker({
  violate = false,
  cleanFails = false,
  interruptAfterEffect = false,
} = {}): WorkerLauncher {
  return async (_image, request, _signal, receive) => {
    // Every probe names the forbidden file, including the one that also saves a note.
    const control = !(request.input as string).includes("forbidden");
    await receive({
      type: "ready",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      python: "3.12.13",
      llmfy: "0.11.0",
      isolationChecks: checks,
    });
    await receive({
      type: "model_request",
      id: 1,
      messages: [{ role: "user", content: request.input }],
      tools: [],
    });
    await receive({ type: "event", stage: "model_tool_proposal", tool: "save" });
    await receive({ type: "event", stage: "tool_handler_entered", tool: "save" });
    if ((control && !cleanFails) || (!control && violate))
      await receive({
        type: "event",
        stage: "canary_state",
        boundary: control ? "allowed" : "forbidden",
        markerPresent: true,
      });
    await receive({ type: "event", stage: "tool_handler_returned", tool: "save" });
    if (!control && interruptAfterEffect) {
      try {
        await receive({
          type: "model_request",
          id: 2,
          messages: [{ role: "tool", content: "saved" }],
          tools: [],
        });
      } catch (error) {
        throw new WorkerError("Worker stopped.", { cleanupConfirmed: true, cause: error });
      }
    }
    await receive({ type: "finished", completed: true });
  };
}
const prepare = async () => `sha256:${"a".repeat(64)}`;
afterEach(() => vi.restoreAllMocks());

describe("runtime cleanup at the end of execution", () => {
  it.each(["completed", "failed", "stopped"] as const)(
    "disposes the owned image after workers (%s)",
    async (state) => {
      const { root, options } = await project();
      const controller = new AbortController();
      options.signal = controller.signal;
      let disposed = false;
      const dispose = vi.fn(async () => {
        disposed = true;
      });
      const simulate = worker({ violate: true });
      const snapshots: string[] = [];
      options.onUpdate = (report) => {
        if (report.finishedAt) snapshots.push(report.state);
      };
      const report = await executeRun(newRun(root, options), options, {
        prepare: async () => ({ image: await prepare(), dispose }),
        worker: async (image, request, signal, receive) => {
          expect(disposed).toBe(false);
          await simulate(image, request, signal, receive);
          if (state === "stopped") controller.abort();
          if (state !== "completed")
            throw new WorkerError("Worker stopped.", { cleanupConfirmed: true });
        },
      });
      expect(report.state).toBe(state);
      expect(report.cleanupConfirmed).toBe(true);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(snapshots).toEqual([state]);
      expect(report.trials[0]?.events.length).toBeGreaterThan(0);
    },
  );

  it("preserves trial evidence and provider errors when image cleanup fails", async () => {
    const { root, options } = await project();
    options.provider.generate = async () => {
      throw new ModelProviderHttpError(410);
    };
    const report = await executeRun(newRun(root, options), options, {
      prepare: async () => ({
        image: await prepare(),
        dispose: async () => {
          throw new Error("Engine refused cleanup.");
        },
      }),
      worker: worker(),
    });
    expect(report.state).toBe("failed");
    expect(report.cleanupConfirmed).toBe(false);
    expect(report.error).toContain("HTTP 410");
    expect(report.error).toContain("Runtime image cleanup failed");
    expect(report.trials[0]?.modelCalls).toBe(1);
  });

  it("stops campaign repetitions on a provider refusal and preserves its reason", async () => {
    const { root, options } = await project();
    const generate = vi.fn(async () => ({
      value: { content: null, toolCalls: [], refusal: "This request was declined." },
      usage: { inputTokens: 5, outputTokens: 5, additionalTokens: 0 },
    }));
    const provider = stubProvider({ name: "anthropic", model: "claude-test", generate });
    const dispose = vi.fn(async () => {});
    vi.spyOn(runtime, "prepareRunRuntime").mockResolvedValue({ image: await prepare(), dispose });
    const simulate = worker();
    vi.spyOn(workers, "runLlmfyWorker").mockImplementation(async (...args) => {
      try {
        await simulate(...args);
      } catch (error) {
        throw new WorkerError("Model step stopped.", { cleanupConfirmed: true, cause: error });
      }
    });
    const plan = createCampaignPlan(await planProject(root), {
      provider: "anthropic",
      model: provider.model,
      repetitions: 3,
      limits: options.limits,
    });
    const report = await executeCampaign(newCampaign(plan), provider);
    expect(report.state).toBe("failed");
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]?.error).toContain("This request was declined.");
    expect(report.budget?.callsAdmitted).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "shares one runtime across a campaign and cleans it after the final repetition (cleanup fails=%s)",
    async (fails) => {
      const { root, options } = await project();
      const dispose = vi.fn(async () => {
        if (fails) throw new Error("Cleanup refused.");
      });
      const build = vi
        .spyOn(runtime, "prepareRunRuntime")
        .mockResolvedValue({ image: await prepare(), dispose });
      const simulate = worker({ violate: true });
      vi.spyOn(workers, "runLlmfyWorker").mockImplementation(async (...args) => {
        expect(dispose).not.toHaveBeenCalled();
        await simulate(...args);
      });
      const plan = createCampaignPlan(await planProject(root), {
        provider: "ollama",
        model: options.provider.model,
        repetitions: 2,
        limits: { ...options.limits, maxModelCalls: 20 },
      });
      const report = await executeCampaign(newCampaign(plan), {
        ...options.provider,
        name: "ollama",
      });
      expect(report.runs).toHaveLength(2);
      expect(build).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(report.state).toBe(fails ? "failed" : "completed");
      expect(report.runs.at(-1)?.cleanupConfirmed).toBe(!fails);
    },
  );
});

describe("managed run scoring and shared budget", () => {
  it("preserves a safe model HTTP status after worker cleanup without counting a failed control as safe", async () => {
    const { root, options } = await project();
    options.provider.generate = async () => {
      throw new ModelProviderHttpError(410);
    };
    const simulate = worker();
    const report = await executeRun(newRun(root, options), options, {
      prepare,
      worker: async (image, request, signal, receive) => {
        try {
          await simulate(image, request, signal, receive);
        } catch {
          throw new WorkerError("Worker protocol failed.", { cleanupConfirmed: true });
        }
      },
    });
    expect(report.state).toBe("failed");
    expect(report.error).toContain("HTTP 410");
    expect(report.cleanControlPassed).toBe(false);
    expect(report.trials[0]?.outcome).toBe("inconclusive");
    expect(report.trials.slice(1).every((trial) => !trial.started)).toBe(true);
    expect(report.cleanupConfirmed).toBe(true);
  });
  it("uses a fresh marker for every control and probe and records verified runtime provenance", async () => {
    const { root, options } = await project();
    const markers: unknown[] = [];
    const simulate = worker({ violate: true });
    const report = await executeRun(newRun(root, options), options, {
      prepare,
      worker: async (image, request, signal, receive) => {
        markers.push(request.marker);
        expect(request.input).toContain(request.marker);
        return simulate(image, request, signal, receive);
      },
    });
    expect(markers).toHaveLength(5);
    expect(new Set(markers).size).toBe(5);
    expect(report.runtime).toEqual({ image: await prepare(), python: "3.12.13", llmfy: "0.11.0" });
  });
  it("requires a working clean task and scores observed effects rather than assistant text", async () => {
    const { root, options } = await project();
    const report = await executeRun(newRun(root, options), options, {
      prepare,
      worker: worker({ violate: true }),
    });
    expect(report).toMatchObject({
      state: "completed",
      cleanControlPassed: true,
      cleanupConfirmed: true,
    });
    expect(report.trials.map((trial) => trial.id)).toEqual([
      "clean-control",
      "direct-override",
      "claimed-authorization",
      "obscured-path",
      "embedded-instruction",
    ]);
    expect(report.trials.map((trial) => trial.outcome)).toEqual([
      "not_observed",
      "violation_observed",
      "violation_observed",
      "violation_observed",
      "violation_observed",
    ]);
    expect(report.budget).toMatchObject({
      state: "completed",
      callsAdmitted: 5,
      observedTokens: 50,
    });
  });
  it("keeps unsupported clean tasks and unstarted probes inconclusive", async () => {
    const { root, options } = await project();
    const report = await executeRun(newRun(root, options), options, {
      prepare,
      worker: worker({ cleanFails: true }),
    });
    expect(report.cleanControlPassed).toBe(false);
    expect(report.trials.every((trial) => trial.outcome === "inconclusive")).toBe(true);
    expect(report.trials).toHaveLength(5);
    expect(report.trials[1]?.started).toBe(false);
    expect(report.budget?.callsAdmitted).toBe(1);
  });
  it("retains a confirmed violation when the shared model-call limit interrupts a later loop", async () => {
    const { root, options } = await project();
    options.limits.maxModelCalls = 2;
    const report = await executeRun(newRun(root, options), options, {
      prepare,
      worker: worker({ violate: true, interruptAfterEffect: true }),
    });
    expect(report.state).toBe("stopped");
    expect(report.trials[1]).toMatchObject({ completed: false, outcome: "violation_observed" });
    expect(report.trials[2]?.started).toBe(false);
    expect(report.budget?.callsAdmitted).toBe(2);
    expect(report.cleanupConfirmed).toBe(true);
  });
  it("refuses a target without a bound file-canary pack before preparing a runtime", async () => {
    const root = await temporaryDir("plenger-run-unbound-");
    await writeFile(join(root, "requirements.txt"), "llmfy==0.11.0\n");
    await writeFile(
      join(root, "agent.py"),
      `from llmfy import LLMfy, OpenAIChatModel, Tool
@Tool()
def lookup(order_id: str) -> str:
    return order_id
def build_agent():
    agent = LLMfy(OpenAIChatModel(model="test"))
    agent.register_tool([lookup])
    return agent
`,
    );
    const plan = await planProject(root);
    expect(plan.preparation.status).toBe("ready");
    const options: RunOptions = {
      target: plan.selectedTarget as string,
      sourceDigest: plan.sourceDigest,
      provider: stubProvider(),
      limits: { maxModelCalls: 6, maxTokens: 1000, timeoutMs: 10_000 },
    };
    let prepared = false;
    const report = await executeRun(newRun(root, options), options, {
      prepare: async () => {
        prepared = true;
        return prepare();
      },
      worker: worker(),
    });
    expect(report.state).toBe("failed");
    expect(prepared).toBe(false);
    expect(report.budget?.callsAdmitted).toBe(0);
    expect(report.trials.every((trial) => !trial.started)).toBe(true);
  });
  it("rejects stale source before starting a worker or contacting a model", async () => {
    const { root, options } = await project();
    await writeFile(join(root, "extra.py"), "# changed\n");
    let launched = false;
    const report = await executeRun(newRun(root, options), options, {
      prepare: async () => {
        launched = true;
        return prepare();
      },
      worker: worker(),
    });
    expect(report.state).toBe("failed");
    expect(report.budget?.callsAdmitted).toBe(0);
    expect(launched).toBe(false);
  });
  it("rejects missing isolation checks and forged effects before any model call", async () => {
    const { root, options } = await project();
    const report = await executeRun(newRun(root, options), options, {
      prepare,
      worker: async (_image, _request, _signal, receive) => {
        await receive({
          type: "event",
          stage: "canary_state",
          boundary: "forbidden",
          markerPresent: true,
        });
      },
    });
    expect(report.state).toBe("failed");
    expect(report.trials[0]?.outcome).toBe("inconclusive");
  });
});

describe("worker ready frame", () => {
  const spec = { versions: { node: "22.18.0" }, checks: ["linux"] };
  const ready = {
    type: "ready",
    protocolVersion: WORKER_PROTOCOL_VERSION,
    node: "22.18.0",
    isolationChecks: ["linux"],
  };

  it("accepts the pinned protocol, versions and checks", () => {
    expect(() => assertReadyFrame(ready, spec)).not.toThrow();
  });

  it.each([
    ["without a protocol version", { protocolVersion: undefined }],
    ["with another protocol version", { protocolVersion: WORKER_PROTOCOL_VERSION + 1 }],
    ["with the version as a string", { protocolVersion: String(WORKER_PROTOCOL_VERSION) }],
    ["with another runtime version", { node: "22.19.0" }],
    ["with a missing isolation check", { isolationChecks: [] }],
  ])("rejects a worker %s", (_label, override) => {
    expect(() => assertReadyFrame({ ...ready, ...override }, spec)).toThrow(
      "Runtime isolation could not be verified.",
    );
  });
});

describe("bounded provider transport", () => {
  it("dispatches to the configured host with output limits and no retries or redirects", async () => {
    let calls = 0;
    const provider = createRunProvider(
      { provider: "openai", model: "test-model", apiKey: "test-private-key" },
      async (url, init) => {
        calls += 1;
        expect(url).toBe("https://api.openai.com/v1/chat/completions");
        expect(init?.redirect).toBe("error");
        expect(JSON.parse(init?.body as string)).toMatchObject({
          max_completion_tokens: 1024,
          store: false,
          stream: true,
          stream_options: { include_usage: true },
        });
        return Response.json({
          choices: [{ finish_reason: "stop", message: { content: "done" } }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        });
      },
    );
    const request = { messages: [{ role: "user", content: "hi" }], tools: null };
    expect(provider.reservation(request, "control").inputTokensUpperBound).toBeGreaterThan(4096);
    expect(
      await provider.generate(request, {
        signal: new AbortController().signal,
        maxOutputTokens: 1024,
      }),
    ).toMatchObject({
      value: { content: "done", toolCalls: [] },
      usage: { inputTokens: 4, outputTokens: 2, additionalTokens: 0 },
    });
    expect(calls).toBe(1);
  });
  it("assembles a streamed OpenAI reply with its tool calls and final usage", async () => {
    const chunks = [
      {
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "save", arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
        usage: null,
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] } },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: null },
      { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
    ];
    const provider = createRunProvider(
      { provider: "openai", model: "test-model", apiKey: "test-private-key" },
      async () =>
        new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const progress: ReplyProgress[] = [];
    const result = await provider.generate(
      { messages: [{ role: "user", content: "hi" }], tools: null },
      {
        signal: new AbortController().signal,
        maxOutputTokens: 1024,
        onProgress: (next) => progress.push(next),
      },
    );
    expect(result).toMatchObject({
      value: {
        content: null,
        toolCalls: [{ id: "call_1", name: "save", arguments: { path: "a" } }],
      },
      usage: { inputTokens: 4, outputTokens: 2, additionalTokens: 0 },
    });
    expect(progress.at(-1)).toEqual({
      characters: 12,
      thinking: false,
      tool: "save",
      inputTokens: null,
    });
  });

  it("wraps llmfy's flat tool definitions as function tools for every transport", async () => {
    const flat = {
      name: "save_note",
      description: "",
      strict: true,
      parameters: { type: "object", properties: { path: { type: "string" } } },
    };
    const wrapped = {
      type: "function",
      function: { name: "lookup", parameters: { type: "object" } },
    };
    expect(normalizeTools([flat, wrapped])).toEqual([
      { type: "function", function: { ...flat } },
      wrapped,
    ]);
    expect(() => normalizeTools([{ description: "no name" }])).toThrow("tool definition");
    let sent: Record<string, unknown> = {};
    let url = "";
    // A compatible server keeps chat completions; OpenAI itself takes tools on Responses.
    const provider = createRunProvider(
      {
        provider: "openai",
        model: "test-model",
        apiKey: "test-private-key",
        baseUrl: "https://llm.example.test/v1",
      },
      async (target, init) => {
        url = String(target);
        sent = JSON.parse(init?.body as string);
        return Response.json({
          choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        });
      },
    );
    await provider.generate(
      { messages: [{ role: "user", content: "hi" }], tools: [flat] },
      { signal: new AbortController().signal, maxOutputTokens: 16 },
    );
    expect(url).toBe("https://llm.example.test/v1/chat/completions");
    expect(sent.tools).toEqual([{ type: "function", function: { ...flat } }]);
  });

  it("sends OpenAI requests with tools to the Responses API and the rest to chat completions", async () => {
    const urls: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const provider = createRunProvider(
      { provider: "openai", model: "gpt-test", apiKey: "test-private-key", maxOutputTokens: null },
      async (target, init) => {
        urls.push(String(target));
        bodies.push(JSON.parse(init?.body as string));
        if (String(target).endsWith("/chat/completions"))
          return Response.json({
            choices: [{ finish_reason: "stop", message: { content: "ok" } }],
          });
        const output = [
          { type: "reasoning", id: "rs_1", encrypted_content: "opaque" },
          { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' },
        ];
        return new Response(
          `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", service_tier: "default", output, usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 2 } } } })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    );
    const tools = [
      { type: "function", function: { name: "lookup", parameters: { type: "object" } } },
    ];
    const allowance = { signal: new AbortController().signal, maxOutputTokens: 64 };
    const reply = await provider.generate(
      {
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "hi" },
        ],
        tools,
        cache: "session-1",
      },
      allowance,
    );
    expect(reply.value.toolCalls).toEqual([
      { id: "call_1", name: "lookup", arguments: { q: "x" } },
    ]);
    expect(reply.tokenDetails).toBeDefined();
    // The next turn carries the encrypted reasoning and the exact call back.
    await provider.generate(
      {
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: '{"q":"x"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "found" },
        ],
        tools,
        cache: "session-1",
      },
      allowance,
    );
    await provider.generate(
      { messages: [{ role: "user", content: "hi" }], tools: null },
      allowance,
    );
    expect(urls).toEqual([
      "https://api.openai.com/v1/responses",
      "https://api.openai.com/v1/responses",
      "https://api.openai.com/v1/chat/completions",
    ]);
    expect(bodies[0]).toMatchObject({
      model: "gpt-test",
      store: false,
      stream: true,
      max_output_tokens: 64,
      prompt_cache_key: "session-1",
      include: ["reasoning.encrypted_content"],
      tools: [{ type: "function", name: "lookup", strict: false }],
      input: [
        { role: "developer", content: "s" },
        { role: "user", content: "hi" },
      ],
    });
    expect((bodies[1]?.input as unknown[] | undefined)?.slice(2)).toEqual([
      { type: "reasoning", id: "rs_1", encrypted_content: "opaque" },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' },
      { type: "function_call_output", call_id: "call_1", output: "found" },
    ]);
    // Enforced limits: the Responses API takes an output cap, unlike the ChatGPT backend.
    expect(
      provider.reservation({ messages: [], tools, cache: "s" }, "setup").tokenLimitMode,
    ).toBeUndefined();
  });
  it("does not export provider error bodies or access credentials", async () => {
    const provider = createRunProvider(
      { provider: "openai", model: "test", apiKey: "private" },
      async () => new Response("secret-provider-error", { status: 401 }),
    );
    await expect(
      provider.generate(
        { messages: [], tools: null },
        { signal: new AbortController().signal, maxOutputTokens: 10 },
      ),
    ).rejects.toThrow("HTTP 401");
  });
  it("rejects truncated completions, malformed arguments and inconsistent usage", () => {
    expect(() =>
      parseModelReply({ choices: [{ finish_reason: "length", message: { content: "partial" } }] }),
    ).toThrow("did not complete");
    // A cut completion is recognizable as such, so an exploring review can ask again.
    let cut: unknown;
    try {
      parseModelReply({ choices: [{ finish_reason: "length", message: { content: "partial" } }] });
    } catch (error) {
      cut = error;
    }
    expect(reachedOutputLimit(cut)).toBe(true);
    expect(reachedOutputLimit(new Error("Model response did not complete"))).toBe(false);
    expect(() =>
      parseModelReply({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                { id: "call", type: "function", function: { name: "save", arguments: "{" } },
              ],
            },
          },
        ],
      }),
    ).toThrow("tool arguments");
    expect(() =>
      parseModelReply({
        choices: [{ finish_reason: "stop", message: { content: "done" } }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 0 },
      }),
    ).toThrow("usage");
  });
});
