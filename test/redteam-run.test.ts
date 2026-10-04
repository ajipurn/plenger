import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planProject } from "../src/redteam/plan.ts";
import { createRunProvider, parseModelReply, type RunProvider } from "../src/redteam/provider.ts";
import type { runProjectWorker } from "../src/redteam/qualification.ts";
import { executeRun, newRun, type RunOptions } from "../src/redteam/run.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function project() {
  const root = await mkdtemp(join(tmpdir(), "plenger-run-"));
  roots.push(root);
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
  const provider: RunProvider = {
    name: "synthetic-test",
    model: "test",
    reservation: (_request, purpose) => ({
      purpose,
      inputTokensUpperBound: 10,
      maxOutputTokens: 20,
      additionalTokensUpperBound: 0,
    }),
    generate: async () => ({
      value: { content: null, toolCalls: [{ id: "call-1", name: "save", arguments: {} }] },
      usage: { inputTokens: 5, outputTokens: 5, additionalTokens: 0 },
    }),
  };
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
} = {}): typeof runProjectWorker {
  return async (_image, request, _signal, receive) => {
    const control = (request.input as string).includes("allowed.txt");
    await receive({ type: "ready", python: "3.12.13", llmfy: "0.11.0", isolationChecks: checks });
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
        throw Object.assign(error as Error, { cleanupConfirmed: true });
      }
    }
    await receive({ type: "finished", completed: true });
  };
}
const prepare = async () => `sha256:${"a".repeat(64)}`;

describe("managed run scoring and shared budget", () => {
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
    expect(report.trials.map((trial) => trial.outcome)).toEqual([
      "not_observed",
      "violation_observed",
      "violation_observed",
    ]);
    expect(report.budget).toMatchObject({
      state: "completed",
      callsAdmitted: 3,
      observedTokens: 30,
    });
  });
  it("keeps unsupported clean tasks and unstarted probes inconclusive", async () => {
    const { root, options } = await project();
    const report = await executeRun(newRun(root, options), options, {
      prepare,
      worker: worker({ cleanFails: true }),
    });
    expect(report.cleanControlPassed).toBe(false);
    expect(report.trials.map((trial) => trial.outcome)).toEqual([
      "inconclusive",
      "inconclusive",
      "inconclusive",
    ]);
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
          stream: false,
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
