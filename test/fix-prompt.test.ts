import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderAccess } from "../src/redteam/provider.ts";
import { type FixPromptContext, generateFixPrompt } from "../src/remediation/fix-prompt.ts";
import { RULES } from "../src/rules/index.ts";

const access: ProviderAccess = {
  provider: "anthropic",
  model: "claude-test",
  apiKey: "local-private-key",
  maxOutputTokens: 4096,
};
const context: FixPromptContext & { finding: import("../src/rules/model.ts").Finding } = {
  scan: { id: "scan-one", createdAt: "2026-10-15T00:00:00.000Z" },
  finding: {
    rule: "PLG101",
    fingerprint: "finding-one",
    title: "Tool runs a model-controlled shell command",
    severity: "critical",
    confidence: "high",
    score: 95,
    location: { path: "tools.ts", line: 15, column: 1, endLine: 15, endColumn: 45 },
    subject: { kind: "tool", name: "shell" },
    snippet: "execute: async ({command}) => execSync(command)",
    evidence: [
      {
        location: { path: "tools.ts", line: 15, column: 1, endLine: 15, endColumn: 45 },
        message: "Command sink",
      },
    ],
    notes: ["Input is model-controlled."],
    exposed: true,
  },
  rule: RULES.find((rule) => rule.id === "PLG101") ?? null,
};

function response(value: unknown, stopReason = "end_turn"): Response {
  return Response.json({
    type: "message",
    role: "assistant",
    stop_reason: stopReason,
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    usage: { input_tokens: 100, output_tokens: 100 },
  });
}

afterEach(() => vi.useRealTimers());

describe("coding agent fix prompt generation", () => {
  it("uses one bounded request, redacts input and output, and preserves canonical evidence", async () => {
    const input = structuredClone(context);
    const sourceSecret = `sk-ant-api03-${"N7aQ2xP4".repeat(6)}`;
    input.finding.notes.push(`Source credential: ${sourceSecret}; provider key: ${access.apiKey}`);
    const before = structuredClone(input);
    const dispatch = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      const submitted = JSON.parse(body.messages[0].content[0].text);
      expect(submitted.finding.fingerprint).toBe(context.finding.fingerprint);
      expect(submitted.rule.remediation).toBe(context.rule?.remediation);
      expect(body.max_tokens).toBe(2048);
      expect(body.tools).toBeUndefined();
      expect(init?.redirect).toBe("error");
      expect(JSON.stringify(body)).not.toContain(sourceSecret);
      expect(JSON.stringify(body)).not.toContain(access.apiKey);
      return response({
        status: "generated",
        prompt: `Inspect tools.ts and replace the shell boundary. ${sourceSecret} ${access.apiKey}`,
      });
    });
    const result = await generateFixPrompt(input, access, {}, dispatch);
    expect(result.status).toBe("generated");
    if (result.status !== "generated") throw new Error("Missing prompt.");
    expect(result.prompt).toContain("Inspect tools.ts and replace the shell boundary.");
    expect(result.prompt).toContain(context.finding.fingerprint);
    expect(result.prompt).toContain(context.scan.createdAt);
    expect(result.prompt).toContain("not a confirmed vulnerability");
    expect(result.prompt).toContain("regression coverage");
    expect(result.prompt).not.toContain(sourceSecret);
    expect(result.prompt).not.toContain(access.apiKey);
    expect(input).toEqual(before);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(["native", "structured"])("stops on a %s refusal without retrying", async (kind) => {
    const dispatch = vi.fn<typeof fetch>(async () =>
      kind === "native"
        ? response(`Declined ${access.apiKey}`, "refusal")
        : response({ status: "refused", reason: `Declined ${access.apiKey}` }),
    );
    const result = await generateFixPrompt(context, access, {}, dispatch);
    expect(result.status).toBe("refused");
    expect(result).not.toHaveProperty("prompt");
    expect(JSON.stringify(result)).not.toContain(access.apiKey);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "malformed JSON", value: "not JSON" },
    { label: "empty prompt", value: { status: "generated", prompt: "" } },
    { label: "oversized prompt", value: { status: "generated", prompt: "x".repeat(12_001) } },
    {
      label: "extra fields",
      value: { status: "generated", prompt: "instructions", command: "run" },
    },
    { label: "invalid refusal", value: { status: "refused", prompt: "instructions" } },
  ])("rejects $label without a fallback prompt", async ({ value }) => {
    const dispatch = vi.fn<typeof fetch>(async () => response(value));
    await expect(generateFixPrompt(context, access, {}, dispatch)).rejects.toThrow(
      "complete fix prompt",
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized evidence before dispatch and uses its own output allowance", async () => {
    const input = structuredClone(context);
    input.finding.notes = ["x".repeat(25 * 1024)];
    const dispatch = vi.fn<typeof fetch>(async (_url, init) => {
      // A saved per-call red-team limit would truncate the prompt; the allowance applies.
      expect(JSON.parse(init?.body as string).max_tokens).toBe(2048);
      return response({ status: "generated", prompt: "Investigate tools.ts." });
    });
    await expect(generateFixPrompt(input, access, {}, dispatch)).rejects.toThrow(
      "too much evidence",
    );
    expect(dispatch).not.toHaveBeenCalled();
    await generateFixPrompt(context, { ...access, maxOutputTokens: 512 }, {}, dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight request and enforces the deadline even if the provider never settles", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const dispatch = vi.fn<typeof fetch>(async (_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const controller = new AbortController();
    const cancelled = generateFixPrompt(context, access, { signal: controller.signal }, dispatch);
    const cancellation = expect(cancelled).rejects.toThrow("cancelled");
    controller.abort();
    await cancellation;
    expect(signal?.aborted).toBe(true);
    const timedOut = generateFixPrompt(context, access, {}, dispatch);
    const deadline = expect(timedOut).rejects.toThrow("timed out after 60 seconds");
    await vi.advanceTimersByTimeAsync(60_001);
    await deadline;
    expect(signal?.aborted).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
