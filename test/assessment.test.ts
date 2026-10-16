import { readFile, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Ajv } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assessProject } from "../src/assessment/assess.ts";
import { formatAssessment } from "../src/assessment/format.ts";
import {
  ASSESSMENT_LIMITS,
  ASSESSMENT_REPORT_SCHEMA,
  type AssessmentData,
} from "../src/assessment/model.ts";
import { main } from "../src/cli/index.ts";
import { PROVIDER_URLS } from "../src/redteam/provider-config.ts";
import { ProviderRepository } from "../src/storage/provider-repository.ts";
import { temporaryDir } from "./support/tmp.ts";

const access = {
  provider: "anthropic" as const,
  model: "claude-test",
  apiKey: "local-private-key",
  maxOutputTokens: 4096,
};
const source = `from openai import OpenAI
client = OpenAI()
def chat(text):
    return client.chat.completions.create(model="model", messages=[{"role": "user", "content": text}])
`;
function data(overrides: Partial<AssessmentData> = {}): AssessmentData {
  return {
    status: "completed",
    reason: null,
    summary: "The chat boundary accepts untrusted user input.",
    assets: [
      {
        name: "Model access",
        description: "The application calls a model.",
        evidence: [{ path: "agent.py", line: 4 }],
      },
    ],
    trustBoundaries: [
      {
        name: "User to model",
        description: "User content reaches the model.",
        evidence: [{ path: "agent.py", line: 4 }],
      },
    ],
    threats: [
      {
        category: "Denial of service",
        title: "Unbounded model usage",
        severity: "medium",
        impact: "Repeated calls could consume the model budget.",
        mitigation: "Enforce request and token budgets.",
        evidence: [{ path: "agent.py", line: 4 }],
      },
    ],
    limitations: ["Deployment rate limits are unknown."],
    ...overrides,
  };
}
function response(value: unknown = data(), stop_reason = "end_turn"): Response {
  return Response.json({
    type: "message",
    role: "assistant",
    stop_reason,
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    usage: { input_tokens: 100, output_tokens: 200 },
  });
}
async function project() {
  const root = await temporaryDir("plenger-assessment-");
  await writeFile(join(root, "agent.py"), source);
  return root;
}
async function cli(...argv: string[]) {
  const output: string[] = [],
    errors: string[] = [];
  const code = await main(argv, {
    stdout: (text) => output.push(text),
    stderr: (text) => errors.push(text),
    color: false,
  });
  return { code, stdout: output.join(""), stderr: errors.join("") };
}
const ajv = new Ajv({ strict: false });
const addFormats: FormatsPlugin = createRequire(import.meta.url)("ajv-formats");
addFormats(ajv);
const validate = ajv.compile(ASSESSMENT_REPORT_SCHEMA);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("read-only Claude assessments", () => {
  it("submits only scoped, redacted scan evidence and never executes project code", async () => {
    const root = await project();
    const outside = await temporaryDir();
    const marker = join(outside, "executed.txt");
    const sourceSecret = `sk-ant-api03-${"N7aQ2xP4".repeat(6)}`;
    const code = `${source}\nfrom pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("executed")\nclient = OpenAI(api_key=${JSON.stringify(sourceSecret)})\n`;
    await writeFile(join(root, "agent.py"), code);
    await writeFile(join(root, ".env"), "PASSWORD=must-never-be-read");
    await writeFile(join(root, ".gitignore"), "ignored.py\n");
    await writeFile(join(root, "ignored.py"), "excluded_value = 'must-never-be-sent'\n");
    await writeFile(join(outside, "outside.py"), "outside_value = 'must-never-be-sent'\n");
    if (process.platform !== "win32")
      await symlink(join(outside, "outside.py"), join(root, "link.py"));
    const dispatch = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.tools).toBeUndefined();
      expect(body.messages).toHaveLength(1);
      const context = JSON.parse(body.messages[0].content[0].text);
      expect(context.files.map((file: { path: string }) => file.path)).toEqual(["agent.py"]);
      expect(JSON.stringify(body)).not.toContain(sourceSecret);
      expect(JSON.stringify(body)).not.toContain(access.apiKey);
      expect(JSON.stringify(body)).not.toContain("must-never-be");
      return response(data({ summary: `Review ${sourceSecret} ${access.apiKey}` }));
    });
    const report = await assessProject(root, { access }, dispatch);
    expect(report.status).toBe("completed");
    expect(report.mode).toBe("read-only");
    expect(report.summary).not.toContain(sourceSecret);
    expect(report.summary).not.toContain(access.apiKey);
    expect(report.request).toMatchObject({
      calls: 1,
      usage: { inputTokens: 100, outputTokens: 200, additionalTokens: 0 },
      accountedTokens: 300,
    });
    expect(report.scope.contextDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(await readFile(join(root, "agent.py"), "utf8")).toBe(code);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(["provider", "structured"])(
    "records a %s refusal and stops after one call",
    async (kind) => {
      const dispatch = vi.fn<typeof fetch>(async () =>
        kind === "provider"
          ? response("I cannot perform this assessment.", "refusal")
          : response(
              data({
                status: "refused",
                reason: "I cannot perform this assessment.",
                assets: [],
                trustBoundaries: [],
                threats: [],
              }),
            ),
      );
      const report = await assessProject(await project(), { access }, dispatch);
      expect(report).toMatchObject({
        status: "refused",
        reason: "I cannot perform this assessment.",
        threats: [],
        request: { calls: 1 },
      });
      expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { path: "../outside.py", line: 1 },
    { path: "agent.py", line: 999 },
    { path: "agent.py", line: 0 },
  ])("rejects fabricated or out-of-scope evidence (%j)", async (evidence) => {
    const value = data();
    if (value.threats[0]) value.threats[0].evidence = [evidence];
    const dispatch = vi.fn<typeof fetch>(async () => response(value));
    const report = await assessProject(await project(), { access }, dispatch);
    expect(report).toMatchObject({
      status: "failed",
      threats: [],
      reason: expect.stringContaining("outside the submitted"),
    });
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("fails closed on malformed JSON and unexpected model metadata without retrying", async () => {
    for (const value of [
      "not JSON",
      { ...data(), apiKey: "not-allowed" },
      data({ status: "refused", reason: "declined" }),
    ]) {
      const dispatch = vi.fn<typeof fetch>(async () => response(value));
      const report = await assessProject(await project(), { access }, dispatch);
      expect(report).toMatchObject({ status: "failed", threats: [] });
      expect(dispatch).toHaveBeenCalledTimes(1);
    }
  });

  it("caps context, records omissions, and cites only included files", async () => {
    const root = await project();
    await writeFile(
      join(root, "large.py"),
      Array.from({ length: 300 }, (_, index) => `call_${index}(untrusted_value)\n`).join(""),
    );
    const report = await assessProject(root, { access }, async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(Buffer.byteLength(body.messages[0].content[0].text)).toBeLessThanOrEqual(
        ASSESSMENT_LIMITS.contextBytes,
      );
      return response();
    });
    expect(report.scope).toMatchObject({ scannedFiles: 2, omittedFiles: 1, partial: true });
  });

  it("denies over-budget and cancelled requests before dispatch", async () => {
    const dispatch = vi.fn<typeof fetch>(async () => response());
    const root = await project();
    expect(await assessProject(root, { access, maxTokens: 1 }, dispatch)).toMatchObject({
      status: "failed",
      request: { calls: 0 },
      reason: expect.stringContaining("token-limit"),
    });
    expect(
      await assessProject(root, { access, signal: AbortSignal.abort() }, dispatch),
    ).toMatchObject({
      status: "failed",
      request: { calls: 0 },
      reason: expect.stringContaining("cancelled"),
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("aborts an unresponsive request at the deadline without retrying", async () => {
    const dispatch = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("Interrupted")), {
            once: true,
          });
        }),
    );
    const report = await assessProject(await project(), { access, timeoutMs: 20 }, dispatch);
    expect(report).toMatchObject({
      status: "failed",
      reason: "Assessment stopped: deadline.",
      request: { calls: 1, usage: null },
    });
    expect(report.request.accountedTokens).toBeGreaterThan(4096);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("never executes a tool proposed by an unexpected response", async () => {
    const dispatch = vi.fn<typeof fetch>(async () =>
      Response.json({
        type: "message",
        role: "assistant",
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "toolu_1", name: "shell", input: { command: "untrusted" } },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    );
    const report = await assessProject(await project(), { access }, dispatch);
    expect(report).toMatchObject({
      status: "failed",
      threats: [],
      reason: "Claude returned an unsupported assessment response.",
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("emits escaped Markdown and keeps its generated JSON schema in sync", async () => {
    const report = await assessProject(await project(), { access }, async () =>
      response(data({ summary: "<script>alert(1)</script> [open](https://example.com)" })),
    );
    const markdown = formatAssessment(report, "markdown");
    expect(markdown).toContain("# Security assessment");
    expect(markdown).toContain("## STRIDE threats");
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("[open](");
    expect(JSON.parse(formatAssessment(report, "json"))).toEqual(report);
    expect(
      JSON.parse(
        await readFile(
          new URL("../schemas/security-assessment-v1.schema.json", import.meta.url),
          "utf8",
        ),
      ),
    ).toEqual(ASSESSMENT_REPORT_SCHEMA);
  });
});

describe("plenger assess", () => {
  it("runs through main with an explicitly named environment variable and saves a redacted report", async () => {
    const root = await project();
    const destination = join(await temporaryDir(), "report.json");
    vi.stubEnv("PLENGER_TEST_ANTHROPIC_KEY", access.apiKey);
    const dispatch = vi.fn<typeof fetch>(async () => response());
    vi.stubGlobal("fetch", dispatch);
    const result = await cli(
      "assess",
      root,
      "--model",
      access.model,
      "--api-key-env",
      "PLENGER_TEST_ANTHROPIC_KEY",
      "--json",
      "--output",
      destination,
    );
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    const report = JSON.parse(await readFile(destination, "utf8"));
    expect(report.status).toBe("completed");
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("reuses a saved encrypted Anthropic connection", async () => {
    const directory = join(await temporaryDir(), "data");
    const store = await ProviderRepository.open(directory);
    try {
      store.providers.saveProvider({
        name: "Claude review",
        provider: "anthropic",
        model: access.model,
        baseUrl: PROVIDER_URLS.anthropic,
        temperature: null,
        maxOutputTokens: 4096,
        apiKey: access.apiKey,
      });
    } finally {
      store.close();
    }
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_url, init) => {
        expect(new Headers(init?.headers).get("x-api-key")).toBe(access.apiKey);
        return response();
      }),
    );
    const result = await cli(
      "assess",
      await project(),
      "--provider",
      "Claude review",
      "--data-dir",
      directory,
      "--json",
    );
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(access.apiKey);
    expect(JSON.parse(result.stdout).provider).toMatchObject({
      name: "anthropic",
      model: access.model,
    });
  });

  it("returns exit 1 with the refusal reason, and rejects invalid options before a request", async () => {
    vi.stubEnv("PLENGER_TEST_ANTHROPIC_KEY", access.apiKey);
    const dispatch = vi.fn<typeof fetch>(async () => response("Request declined.", "refusal"));
    vi.stubGlobal("fetch", dispatch);
    const args = [
      "assess",
      await project(),
      "--model",
      access.model,
      "--api-key-env",
      "PLENGER_TEST_ANTHROPIC_KEY",
      "--json",
    ];
    const refused = await cli(...args);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      status: "refused",
      reason: "Request declined.",
    });
    for (const flags of [
      ["--timeout", "0"],
      ["--tokens", "no"],
      ["--format", "sarif"],
      ["--provider", "saved"],
      ["--api-key", "secret"],
    ]) {
      expect((await cli(...args, ...flags)).code).toBe(2);
    }
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await cli("assess", "--help")).stdout).toContain("One model request");
  });
});
