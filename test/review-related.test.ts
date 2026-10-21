import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECURITY_REVIEW_LIMITS } from "../src/assessment/review-model.ts";
import { captureRelatedSource } from "../src/assessment/review-related.ts";
import { captureReviewSource, ReviewSourceReader } from "../src/assessment/review-source.ts";
import { REVIEW_PROMPT_DIGEST, reviewProject } from "../src/assessment/security-review.ts";
import { scan } from "../src/scan.ts";
import { required } from "./support/dashboard.ts";
import {
  nativeReviewReply,
  reviewDecision,
  reviewDiscovery,
  writeReviewProject,
} from "./support/security-review.ts";
import { temporaryDir } from "./support/tmp.ts";

const budget = { bytes: 12 * 1024, fileBytes: 16 * 1024, files: 8 };

/** A handler that imports its guard from auth.py, and a job that calls the handler. */
async function writeProject(root: string): Promise<Record<string, string[]>> {
  await mkdir(root, { recursive: true });
  const files: Record<string, string[]> = {
    "auth.py": [
      "def unrelated():",
      "    return 1",
      "",
      "def require_user(request):",
      "    if not request.user:",
      "        raise PermissionError()",
      "    return request.user",
      "",
    ],
    "api.py": [
      "from auth import require_user",
      "",
      "def get_invoice(request, invoice_id):",
      "    require_user(request)",
      "    return lookup(invoice_id)",
      "",
    ],
    "jobs.py": [
      "from api import get_invoice",
      "",
      "def nightly(request):",
      "    return get_invoice(request, 'all')",
      "",
      "def other():",
      "    return 2",
      "",
    ],
    "notes.py": ["def note():", "    return 'no imports here'", ""],
  };
  for (const [path, lines] of Object.entries(files))
    await writeFile(join(root, path), lines.join("\n"));
  return files;
}

describe("second review context", () => {
  it("adds the definitions a cited file imports and the functions that call it", async () => {
    const root = join(await temporaryDir(), "project");
    const files = await writeProject(root);
    const snapshot = await scan(root);
    const reader = await ReviewSourceReader.open(snapshot, []);
    try {
      const related = await captureRelatedSource(
        reader,
        snapshot,
        { files: [], omitted: [], lines: new Map() },
        ["api.py"],
        budget,
      );
      expect(related.map(({ path, relation, via }) => ({ path, relation, via }))).toEqual([
        { path: "auth.py", relation: "imported", via: "api.py" },
        { path: "jobs.py", relation: "caller", via: "api.py" },
      ]);
      const auth = required(related[0], "auth.py");
      const guard = (files["auth.py"] ?? []).indexOf("def require_user(request):") + 1;
      expect(auth.ranges).toEqual([{ line: guard, endLine: guard + 3 }]);
      expect(auth.source).toContain(`${guard}: def require_user(request):`);
      expect(auth.source).not.toContain("def unrelated");
      const jobs = required(related[1], "jobs.py");
      expect(jobs.source).toContain("def nightly(request):");
      expect(jobs.source).not.toContain("def other");
    } finally {
      reader.dispose();
    }
  });

  it("skips files the batch holds whole and repeats no batch lines", async () => {
    const root = join(await temporaryDir(), "project");
    await writeProject(root);
    const snapshot = await scan(root);
    const reader = await ReviewSourceReader.open(snapshot, []);
    try {
      const { context } = await captureReviewSource(snapshot, [], undefined, [], { reader });
      expect(context.files.map((file) => file.path).sort()).toEqual(
        ["api.py", "auth.py", "jobs.py", "notes.py"].sort(),
      );
      expect(await captureRelatedSource(reader, snapshot, context, ["api.py"], budget)).toEqual([]);
      const excerpt = {
        ...context,
        files: context.files.map((file) =>
          file.path === "auth.py" ? { ...file, ranges: [{ line: 4, endLine: 7 }] } : file,
        ),
      };
      // The imported guard is already in the batch's excerpt of auth.py.
      expect(await captureRelatedSource(reader, snapshot, excerpt, ["api.py"], budget)).toEqual([]);
    } finally {
      reader.dispose();
    }
  });

  it("runs the second review on a separate connection and bills it separately", async () => {
    const snapshot = await scan(await writeReviewProject(await temporaryDir()));
    const access = {
      provider: "anthropic" as const,
      model: "claude-discovery-test",
      apiKey: "discovery-secret-4fT8",
      maxOutputTokens: 8192,
    };
    const validator = {
      provider: { id: "validator", name: "Claude validator", model: "claude-validator-test" },
      access: { ...access, model: "claude-validator-test", apiKey: "validator-secret-9Lq2" },
    };
    const requests: { model: unknown; key: string | null; candidates: boolean }[] = [];
    const dispatch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const messages = body.messages as { content: { text: string }[] }[];
      const data = JSON.parse(messages[0]?.content[0]?.text ?? "{}");
      requests.push({
        model: body.model,
        key: new Headers(init?.headers).get("x-api-key"),
        candidates: Boolean(data.candidates),
      });
      const content = data.candidates
        ? reviewDecision(data.candidates.map((item: { id: string }) => item.id))
        : reviewDiscovery();
      return new Response(JSON.stringify(nativeReviewReply(content)), { status: 200 });
    };
    const review = await reviewProject(
      snapshot,
      {
        scanId: "scan",
        provider: { id: "discovery", name: "Claude", model: access.model },
        access,
        validator,
      },
      dispatch,
    );
    expect(review.status).toBe("completed");
    expect(requests).toEqual([
      { model: "claude-discovery-test", key: "discovery-secret-4fT8", candidates: false },
      { model: "claude-validator-test", key: "validator-secret-9Lq2", candidates: true },
    ]);
    expect(review.validator).toEqual(validator.provider);
    // The record says which instructions and settings produced each request.
    const settings = {
      temperature: null,
      maxOutputTokens: SECURITY_REVIEW_LIMITS.outputTokens,
      structuredOutput: true,
    };
    expect(review.generation).toEqual({
      promptDigest: REVIEW_PROMPT_DIGEST,
      discovery: { provider: "anthropic", model: "claude-discovery-test", ...settings },
      validation: { provider: "anthropic", model: "claude-validator-test", ...settings },
    });
    expect(REVIEW_PROMPT_DIGEST).toMatch(/^[a-f0-9]{64}$/);
    expect(review.request.calls).toBe(2);
    expect(review.request.billing?.usage).toHaveLength(1);
    expect(review.request.validatorBilling?.usage).toHaveLength(1);
    expect(JSON.stringify(review)).not.toContain("validator-secret-9Lq2");
  });
});
