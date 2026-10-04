import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planProject } from "../src/redteam/plan.ts";
import { executeRun, newRun, type RunOptions } from "../src/redteam/run.ts";
import { stubProvider } from "./support/provider.ts";
import { temporaryDir } from "./support/tmp.ts";

const image = process.env.PLENGER_TEST_LLMFY_IMAGE;
async function project(guarded: boolean, asyncEntry = false, asyncFactory = false) {
  const root = await temporaryDir("plenger-worker-test-");
  await writeFile(join(root, "requirements.txt"), "llmfy==0.11.0\n");
  const source = `from pathlib import Path
from llmfy import LLMfy, OpenAIChatModel, Tool
@Tool()
def save(path: str, text: str) -> str:
    """Write text to a file path."""
    ${guarded ? 'if path != "/tmp/plenger-canary/allowed.txt":\n        return "approval-required"\n    ' : ""}Path(path).write_text(text)
    return "saved"
${asyncFactory ? "async " : ""}def build_agent():
    agent = LLMfy(OpenAIChatModel(model="project-model"))
    agent.register_tool([save])
    return agent
${asyncEntry ? 'async def chat(message: str):\n    agent = LLMfy(OpenAIChatModel(model="project-model"))\n    agent.register_tool([save])\n    return await agent.ainvoke_with_tools(message)\n' : ""}`;
  await writeFile(join(root, "agent.py"), source);
  const discovery = await planProject(root);
  const target = discovery.targets.find(
    (item) => item.kind === (asyncEntry ? "function" : "factory"),
  );
  if (!target) throw new Error("Missing test target.");
  const plan = await planProject(root, { target: target.id });
  let dispatches = 0;
  const provider = stubProvider({
    inputTokensUpperBound: 1000,
    maxOutputTokens: 1000,
    generate: async (request) => {
      dispatches += 1;
      const user = request.messages.find(
        (message) => (message as { role: string }).role === "user",
      ) as { content: string };
      const marker = user.content.match(/PLENGER_[a-f0-9]+/)?.[0];
      const path = user.content.includes("forbidden.txt")
        ? "/tmp/plenger-canary/forbidden.txt"
        : "/tmp/plenger-canary/allowed.txt";
      const alreadyCalled = request.messages.some(
        (message) => (message as { role: string }).role === "tool",
      );
      if (!marker) throw new Error("Missing canary marker in test prompt.");
      return {
        value: alreadyCalled
          ? { content: "done", toolCalls: [] }
          : {
              content: null,
              toolCalls: [
                { id: `call-${dispatches}`, name: "save", arguments: { path, text: marker } },
              ],
            },
        usage: { inputTokens: 100, outputTokens: 100, additionalTokens: 0 },
      };
    },
  });
  const options: RunOptions = {
    target: target.id,
    sourceDigest: plan.sourceDigest,
    provider,
    limits: { maxModelCalls: 12, maxTokens: 100_000, timeoutMs: 60_000 },
  };
  return { root, source, options, dispatches: () => dispatches };
}

// Opt in with the bundled immutable runtime; normal static tests stay offline.
describe.skipIf(!image)("managed source snapshot in a real isolated worker", () => {
  it.each([false, true])(
    "preserves the original tool and approval checks (guarded=%s)",
    async (guarded) => {
      const { root, source, options, dispatches } = await project(guarded);
      const report = await executeRun(newRun(root, options), options, {
        prepare: async () => image as string,
      });
      expect(report).toMatchObject({
        state: "completed",
        cleanControlPassed: true,
        cleanupConfirmed: true,
      });
      expect(report.trials.map((trial) => trial.outcome)).toEqual([
        "not_observed",
        guarded ? "not_observed" : "violation_observed",
        guarded ? "not_observed" : "violation_observed",
      ]);
      expect(report.trials[1]?.events.map((event) => event.stage)).toContain(
        "tool_handler_entered",
      );
      expect(dispatches()).toBe(6);
      expect(await readFile(join(root, "agent.py"), "utf8")).toBe(source);
    },
    90_000,
  );

  it("supports an async module entry without requiring instrumentation code", async () => {
    const { root, options } = await project(true, true);
    const report = await executeRun(newRun(root, options), options, {
      prepare: async () => image as string,
    });
    expect(report).toMatchObject({
      state: "completed",
      cleanControlPassed: true,
      cleanupConfirmed: true,
    });
    expect(report.trials.every((trial) => trial.outcome === "not_observed")).toBe(true);
  }, 90_000);

  it("awaits an async factory before invoking its returned agent", async () => {
    const { root, options } = await project(true, false, true);
    const report = await executeRun(newRun(root, options), options, {
      prepare: async () => image as string,
    });
    expect(report).toMatchObject({
      state: "completed",
      cleanControlPassed: true,
      cleanupConfirmed: true,
    });
    expect(report.trials.every((trial) => trial.outcome === "not_observed")).toBe(true);
  }, 90_000);

  it("retains a real canary effect when the next agent loop exceeds the shared budget", async () => {
    const { root, options } = await project(false);
    options.limits.maxModelCalls = 3;
    const report = await executeRun(newRun(root, options), options, {
      prepare: async () => image as string,
    });
    expect(report).toMatchObject({
      state: "stopped",
      cleanControlPassed: true,
      cleanupConfirmed: true,
    });
    expect(report.trials[1]).toMatchObject({ completed: false, outcome: "violation_observed" });
    expect(report.trials[2]?.started).toBe(false);
    expect(report.budget?.callsAdmitted).toBe(3);
  }, 90_000);

  it("kills and cleans the worker when cancellation interrupts a provider request", async () => {
    const { root, options } = await project(false);
    const controller = new AbortController();
    options.signal = controller.signal;
    options.provider.generate = async (_request, { signal }) => {
      controller.abort();
      signal.throwIfAborted();
      throw new Error("Expected cancellation.");
    };
    const report = await executeRun(newRun(root, options), options, {
      prepare: async () => image as string,
    });
    expect(report).toMatchObject({
      state: "stopped",
      cleanupConfirmed: true,
      cleanControlPassed: false,
    });
    expect(report.budget?.callsAdmitted).toBe(1);
  }, 90_000);
});
