import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGitHubAction } from "../scripts/lib/github-action.ts";
import { nativeReviewReply, reviewDecision, reviewDiscovery } from "./support/security-review.ts";
import { temporaryDir } from "./support/tmp.ts";

const key = "ci-review-secret-6Wd1";
/** A Go handler: no static parser, so only the AI review reads it. */
const handler = [
  "package main",
  "",
  'import "net/http"',
  "",
  "func search(w http.ResponseWriter, r *http.Request) {",
  '\tq := r.URL.Query().Get("q")',
  '\tdb.Query("SELECT * FROM users WHERE name = \'" + q + "\'")',
  "}",
  "",
].join("\n");

let model: Server;
let url: string;
let verdict: string;
let requests: Record<string, unknown>[];

beforeEach(async () => {
  verdict = "source-supported";
  requests = [];
  model = createServer(async (request, response) => {
    let text = "";
    for await (const part of request) text += part;
    const body = JSON.parse(text);
    requests.push(JSON.parse(body.messages[0].content[0].text));
    const data = requests.at(-1) as { candidates?: { id: string }[] };
    const discovery = reviewDiscovery();
    const finding = discovery.findings[0];
    if (!finding) throw new Error("Missing finding fixture.");
    const content = data.candidates
      ? reviewDecision(
          data.candidates.map((item) => item.id),
          verdict,
        )
      : {
          ...discovery,
          stride: discovery.stride.map((entry) => ({
            ...entry,
            status: "insufficient-context",
            evidence: [],
          })),
          findings: [
            {
              ...finding,
              title: "Search builds SQL from the query string",
              severity: "high",
              cwe: "CWE-89",
              evidence: [
                { path: "main.go", line: 7, endLine: 7, role: "sink", message: "SQL text." },
              ],
            },
          ],
        };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(nativeReviewReply(content)));
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const address = model.address();
  if (!address || typeof address === "string") throw new Error("No model server.");
  url = `http://127.0.0.1:${address.port}/v1`;
});
afterEach(async () => {
  model.closeAllConnections();
  await new Promise<void>((resolve) => model.close(() => resolve()));
});

async function project(): Promise<string> {
  const root = await temporaryDir("plenger-ci-ai-");
  await writeFile(join(root, "main.go"), handler);
  return root;
}
function env(root: string, patch: Record<string, string> = {}) {
  return {
    GITHUB_WORKSPACE: root,
    GITHUB_STEP_SUMMARY: join(root, "summary.md"),
    PLENGER_FAIL_ON: "high",
    PLENGER_AI_REVIEW: "true",
    PLENGER_AI_PROVIDER: "anthropic",
    PLENGER_AI_MODEL: "claude-ci-test",
    PLENGER_AI_API_KEY: key,
    PLENGER_AI_BASE_URL: url,
    PLENGER_AI_TOKEN_LIMIT: "400000",
    ...patch,
  };
}
async function run(values: Record<string, string>) {
  let stdout = "";
  let stderr = "";
  const code = await runGitHubAction(values, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    color: false,
  });
  return { code, stdout, stderr };
}

describe("GitHub Action AI review", () => {
  it("adds kept AI findings to SARIF and the summary, and gates source-supported ones", async () => {
    const root = await project();
    const result = await run(env(root));
    expect(result.code, result.stderr).toBe(3);
    const sarif = JSON.parse(await readFile(join(root, "plenger.sarif"), "utf8"));
    expect(sarif.runs).toHaveLength(2);
    const ai = sarif.runs[1];
    expect(ai.tool.driver.name).toBe("plenger-ai-review");
    expect(ai.results).toEqual([
      expect.objectContaining({
        ruleId: "AI-CWE-89",
        level: "error",
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: "main.go", uriBaseId: "%SRCROOT%" },
              region: { startLine: 7, endLine: 7 },
            },
          },
        ],
        properties: expect.objectContaining({ validation: "source-supported" }),
      }),
    ]);
    const summary = await readFile(join(root, "summary.md"), "utf8");
    expect(summary).toContain("## Plenger AI review");
    expect(summary).toContain("Whole checkout, one Quick review.");
    expect(summary).toContain(
      "| high | Search builds SQL from the query string | source-supported |",
    );
    expect(result.stdout).toContain("AI review completed; 1 kept findings");
    for (const text of [JSON.stringify(sarif), summary, result.stdout, result.stderr])
      expect(text).not.toContain(key);
    // Only source-supported findings meet the gate.
    verdict = "needs-review";
    expect((await run(env(root))).code).toBe(0);
  });

  it("rejects incomplete inputs before sending anything", async () => {
    const root = await project();
    for (const patch of [
      { PLENGER_AI_REVIEW: "yes" },
      { PLENGER_AI_TOKEN_LIMIT: "" },
      { PLENGER_AI_API_KEY: "" },
      { PLENGER_AI_PROVIDER: "chatgpt" },
      { PLENGER_AI_MODE: "deep" },
    ]) {
      const result = await run(env(root, patch));
      expect(result.code, JSON.stringify(patch)).toBe(2);
      expect(result.stderr).toMatch(/^plenger: ai-/);
    }
    expect(requests).toHaveLength(0);
    // Off by default.
    expect((await run({ GITHUB_WORKSPACE: root, PLENGER_FAIL_ON: "high" })).code).toBe(0);
    expect(requests).toHaveLength(0);
  });
});
