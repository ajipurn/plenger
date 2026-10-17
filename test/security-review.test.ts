import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseReviewDiscovery,
  parseReviewValidation,
  SECURITY_REVIEW_LIMITS,
} from "../src/assessment/review-model.ts";
import { captureReviewSource } from "../src/assessment/review-source.ts";
import { reviewProject } from "../src/assessment/security-review.ts";
import { scan } from "../src/scan.ts";
import { required } from "./support/dashboard.ts";
import {
  nativeReviewReply,
  reviewDecision,
  reviewDiscovery,
  writeReviewProject,
} from "./support/security-review.ts";
import { temporaryDir } from "./support/tmp.ts";

const access = {
  provider: "anthropic" as const,
  model: "claude-review-test",
  apiKey: "owned-provider-secret-9kV2",
  maxOutputTokens: 8192,
};
const provider = { id: "saved-provider", name: "Claude review", model: access.model };

function stub(replies?: (body: Record<string, unknown>, index: number) => unknown) {
  const bodies: Record<string, unknown>[] = [];
  const dispatch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const index = bodies.length - 1;
    let content: unknown;
    if (replies) content = replies(body, index);
    else if (!index) content = reviewDiscovery();
    else {
      const messages = body.messages as { content: { text: string }[] }[];
      const data = JSON.parse(messages[0]?.content[0]?.text ?? "{}");
      content = reviewDecision(data.candidates.map((item: { id: string }) => item.id));
    }
    return new Response(JSON.stringify(nativeReviewReply(content)), { status: 200 });
  };
  return { bodies, dispatch };
}

describe("source-based AI security review", () => {
  it.each(["refusal", "max_tokens", "invalid-json"])(
    "retains billable usage for an unusable %s response without retrying",
    async (outcome) => {
      const snapshot = await scan(await writeReviewProject(await temporaryDir()));
      const model = stub();
      const dispatch: typeof fetch = async (url, init) => {
        const raw = (await (await model.dispatch(url, init)).json()) as Record<string, unknown>;
        raw.usage = { input_tokens: 10, output_tokens: 3 };
        if (outcome === "invalid-json") raw.content = [{ type: "text", text: "invalid-json" }];
        else raw.stop_reason = outcome;
        return Response.json(raw);
      };
      const pricing = {
        model: access.model,
        rates: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
      };
      const result = await reviewProject(
        snapshot,
        { scanId: "scan", provider, access, pricing },
        dispatch,
      );
      expect(result.status).toBe(outcome === "refusal" ? "refused" : "failed");
      expect(result.findings).toEqual([]);
      expect(result.request.calls).toBe(1);
      expect(result.request.billing?.cost?.totalUsd).toBeCloseTo(0.000075, 12);
      expect(result.request.billing?.cost?.complete).toBe(true);
      expect(model.bodies).toHaveLength(1);
    },
  );

  it.each([
    ["discovery", "The supplied source was reviewed."],
    ["validation", "All supplied candidates were reviewed against the submitted source."],
    ["discovery", ""],
    ["validation", ""],
  ])("completes %s with a string top-level reason (%j)", async (stage, reason) => {
    const snapshot = await scan(await writeReviewProject(await temporaryDir()));
    const model = stub((body, index) => {
      if (!index) return { ...reviewDiscovery(), ...(stage === "discovery" ? { reason } : {}) };
      const messages = body.messages as { content: { text: string }[] }[];
      const data = JSON.parse(messages[0]?.content[0]?.text ?? "{}");
      return {
        ...(reviewDecision(data.candidates.map((item: { id: string }) => item.id)) as object),
        ...(stage === "validation" ? { reason } : {}),
      };
    });
    const review = await reviewProject(
      snapshot,
      { scanId: "scan", provider, access },
      model.dispatch,
    );
    expect(review.status, review.reason ?? "").toBe("completed");
    expect(review.reason).toBeNull();
    expect(review.findings[0]?.validation).toBe("source-supported");
    expect(review.findings[0]?.validationReason).toContain("server.ts:3");
    expect(review.request.calls).toBe(2);
  });

  it("normalizes a finding's CWE and takes a missing or unreadable one as none", () => {
    const files = [
      { path: "server.ts", lines: 7, digest: "" },
      { path: "store.ts", lines: 4, digest: "" },
    ];
    const finding = required(reviewDiscovery().findings[0], "finding");
    const parse = (cwe: unknown) => {
      const { cwe: _cwe, ...rest } = finding;
      const item = cwe === undefined ? rest : { ...rest, cwe };
      return parseReviewDiscovery(JSON.stringify({ ...reviewDiscovery(), findings: [item] }), files)
        .findings[0]?.cwe;
    };
    expect(parse("CWE-639")).toBe("CWE-639");
    expect(parse("cwe-89")).toBe("CWE-89");
    expect(parse(918)).toBe("CWE-918");
    expect(parse(undefined)).toBeNull();
    expect(parse(null)).toBeNull();
    expect(parse("SQL injection")).toBeNull();
  });

  it("still rejects malformed reasons, incomplete decisions and invalid citations with completion text", () => {
    const files = [
      { path: "server.ts", lines: 7, digest: "" },
      { path: "store.ts", lines: 4, digest: "" },
    ];
    const discovery = { ...reviewDiscovery(), reason: "Source review completed." };
    const validation = { status: "completed", reason: "Candidates reviewed.", decisions: [] };
    for (const reason of [false, 42, {}, [], "x".repeat(SECURITY_REVIEW_LIMITS.text + 1)]) {
      expect(() => parseReviewDiscovery(JSON.stringify({ ...discovery, reason }), files)).toThrow(
        /\$\.reason/,
      );
      expect(() => parseReviewValidation(JSON.stringify({ ...validation, reason }), [])).toThrow(
        /\$\.reason/,
      );
    }
    expect(() => parseReviewValidation(JSON.stringify(validation), ["candidate"])).toThrow(
      /\$\.decisions/,
    );
    required(required(discovery.findings[0], "finding").evidence[0], "citation").path =
      "outside.ts";
    expect(() => parseReviewDiscovery(JSON.stringify(discovery), files)).toThrow(
      /findings\[0\].evidence\[0\].path/,
    );
    for (const reason of [null, "", " "]) {
      expect(() =>
        parseReviewDiscovery(
          JSON.stringify({ ...discovery, status: "refused", reason, stride: [], findings: [] }),
          files,
        ),
      ).toThrow(/\$\.reason/);
      expect(() =>
        parseReviewValidation(JSON.stringify({ ...validation, status: "refused", reason }), []),
      ).toThrow(/\$\.reason/);
    }
    expect(
      parseReviewValidation(
        JSON.stringify({ ...validation, status: "refused", reason: "Declined" }),
        ["candidate"],
      ),
    ).toEqual({ status: "refused", reason: "Declined", decisions: [] });
  });

  it("accepts provider enum capitalization without losing source validation", async () => {
    const snapshot = await scan(await writeReviewProject(await temporaryDir()));
    const discovery = reviewDiscovery();
    const reply = JSON.parse(JSON.stringify(discovery));
    reply.status = "Completed";
    for (const entry of reply.stride) {
      entry.category = entry.category.replace(/\b\w/g, (letter: string) => letter.toUpperCase());
      entry.status = entry.status.toUpperCase();
      for (const cite of entry.evidence) cite.role = cite.role.toUpperCase();
    }
    reply.findings[0].category = "Information Disclosure";
    reply.findings[0].severity = "High";
    reply.findings[0].confidence = "High";
    for (const cite of reply.findings[0].evidence) cite.role = cite.role.toUpperCase();
    const model = stub((body, index) => {
      if (!index) return reply;
      const messages = body.messages as { content: { text: string }[] }[];
      const source = JSON.parse(messages[0]?.content[0]?.text ?? "{}");
      return {
        status: "Completed",
        reason: null,
        decisions: source.candidates.map((item: { id: string }) => ({
          id: item.id,
          verdict: "Source-Supported",
          reason: "The submitted source supports the cited path.",
        })),
      };
    });
    const review = await reviewProject(
      snapshot,
      { scanId: "scan", provider, access },
      model.dispatch,
    );
    expect(review.status, review.reason ?? "").toBe("completed");
    expect(review.findings[0]).toMatchObject({
      category: "Information disclosure",
      severity: "high",
      confidence: "high",
      validation: "source-supported",
    });
    expect(review.stride.map((item) => item.category)).toEqual(
      discovery.stride.map((item) => item.category),
    );
  });

  it("discovers new findings across complete source files with zero static findings, then checks candidates in a separate request", async () => {
    const root = await writeReviewProject(join(await temporaryDir(), "project"));
    const before = await readFile(join(root, "server.ts"), "utf8");
    const snapshot = await scan(root);
    expect(snapshot.findings).toEqual([]);
    const { bodies, dispatch } = stub();
    const review = await reviewProject(snapshot, { scanId: "scan", provider, access }, dispatch);
    expect(review.status).toBe("completed");
    expect(review.findings).toHaveLength(1);
    expect(review.stride).toHaveLength(6);
    expect(review.findings[0]).toMatchObject({
      validation: "source-supported",
      category: "Information disclosure",
    });
    expect(review.findings[0]?.evidence[1]?.snippet).toContain("db.invoices.findUnique");
    expect(review.scope).toMatchObject({ eligibleFiles: 2, omittedFiles: 0, partial: false });
    expect(review.request).toMatchObject({
      calls: 2,
      usage: { inputTokens: 1000, outputTokens: 1000 },
    });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      const encoded = JSON.stringify(body);
      expect(encoded).toContain("getInvoice");
      expect(encoded).toContain("db.invoices.findUnique");
      expect(encoded).not.toContain(root);
      expect(body.tools).toBeUndefined();
      expect(body.output_config).toMatchObject({ format: { type: "json_schema" } });
      const format = body.output_config as { format: { schema: Record<string, unknown> } };
      expect(format.format.schema.additionalProperties).toBe(false);
      expect(JSON.stringify(format)).not.toMatch(
        /"(?:minLength|maxLength|minimum|maximum|maxItems)":/,
      );
      expect(JSON.stringify(format)).not.toContain("server.ts");
      expect(JSON.stringify(format)).not.toContain("store.ts");
    }
    expect(JSON.stringify(bodies[1])).toContain("counterevidence");
    expect(await readFile(join(root, "server.ts"), "utf8")).toBe(before);
  });

  it("identifies the failed stage and field without accepting unknown files or echoing provider text", async () => {
    const snapshot = await scan(await writeReviewProject(await temporaryDir()));
    const invalid = reviewDiscovery();
    required(required(invalid.findings[0], "finding").evidence[0], "citation").path =
      `../${access.apiKey}.ts`;
    const model = stub(() => invalid);
    const review = await reviewProject(
      snapshot,
      { scanId: "scan", provider, access },
      model.dispatch,
    );
    expect(review.status).toBe("failed");
    expect(review.reason).toContain("Discovery response");
    expect(review.reason).toContain("findings[0].evidence[0].path");
    expect(review.reason).toContain("not submitted");
    expect(review.reason).not.toContain(access.apiKey);
    expect(model.bodies).toHaveLength(1);
    const unknown = stub((_body, index) =>
      index
        ? {
            status: "completed",
            reason: null,
            decisions: [
              { id: "unknown-host-id", verdict: "source-supported", reason: "Asserted by model" },
            ],
          }
        : reviewDiscovery(),
    );
    const second = await reviewProject(
      snapshot,
      { scanId: "scan", provider, access },
      unknown.dispatch,
    );
    expect(second.reason).toContain("Validation response");
    expect(second.reason).toContain("decisions[0].id");
    expect(second.findings).toEqual([]);
    expect(unknown.bodies).toHaveLength(2);
  });

  it("normalizes known enum casing while keeping source paths case-sensitive and refusing unknown categories", () => {
    const files = [
      { path: "server.ts", lines: 7, digest: "" },
      { path: "store.ts", lines: 4, digest: "" },
    ];
    const differentFile = reviewDiscovery();
    required(required(differentFile.findings[0], "finding").evidence[0], "citation").path =
      "Server.ts";
    expect(() => parseReviewDiscovery(JSON.stringify(differentFile), files)).toThrow(
      /not submitted/,
    );
    const unknownCategory = reviewDiscovery();
    Object.assign(required(unknownCategory.findings[0], "finding"), {
      category: "New invented category",
    });
    expect(() => parseReviewDiscovery(JSON.stringify(unknownCategory), files)).toThrow(
      /findings\[0\].category/,
    );
  });

  it("accepts long in-scope citations while preserving file boundaries and JSON validation", () => {
    const files = [
      { path: "server.ts", lines: 80, digest: "" },
      { path: "store.ts", lines: 4, digest: "" },
    ];
    const value = reviewDiscovery();
    const citation = required(required(value.findings[0], "finding").evidence[0], "citation");
    citation.endLine = 80;
    const threat = required(value.stride[1], "STRIDE entry");
    threat.evidence = [{ ...citation }];
    const result = parseReviewDiscovery(JSON.stringify(value), files);
    expect(result.findings[0]?.evidence[0]?.endLine).toBe(80);
    expect(result.stride[1]?.evidence[0]?.endLine).toBe(80);
    citation.endLine = 81;
    expect(() => parseReviewDiscovery(JSON.stringify(value), files)).toThrow(
      /findings\[0\].evidence\[0\].endLine.*within the submitted file/,
    );
    expect(() => parseReviewDiscovery("not-json", files)).toThrow(/one complete JSON object/);
  });

  it("completes discovery with long STRIDE and finding citations without retrying or expanding snippet previews", async () => {
    const root = await writeReviewProject(await temporaryDir());
    const path = join(root, "server.ts");
    const source = await readFile(path, "utf8");
    await writeFile(
      path,
      `${source}\n${Array.from({ length: 40 }, (_, index) => `// source line ${index}`).join("\n")}\n`,
    );
    const snapshot = await scan(root);
    const model = stub((body, index) => {
      if (index) {
        const messages = body.messages as { content: { text: string }[] }[];
        const data = JSON.parse(messages[0]?.content[0]?.text ?? "{}");
        return reviewDecision(data.candidates.map((item: { id: string }) => item.id));
      }
      const value = reviewDiscovery();
      const citation = required(required(value.findings[0], "finding").evidence[0], "citation");
      citation.endLine = 35;
      required(value.stride[1], "STRIDE entry").evidence = [{ ...citation }, { ...citation }];
      return value;
    });
    const review = await reviewProject(
      snapshot,
      { scanId: "scan", provider, access },
      model.dispatch,
    );
    expect(review.status, review.reason ?? "").toBe("completed");
    expect(review.request.calls).toBe(2);
    expect(model.bodies).toHaveLength(2);
    expect(review.stride[1]?.evidence[1]?.endLine).toBe(35);
    const evidence = required(review.findings[0]?.evidence[0], "saved evidence");
    expect(evidence.endLine).toBe(35);
    expect(evidence.snippet).toContain("more cited lines");
    expect(evidence.snippet).not.toMatch(/^35:/m);
    expect(evidence.snippet.split("\n").filter((line) => /^\d+:/.test(line))).toHaveLength(13);
  });

  it("keeps dismissed candidates for audit and cannot promote a candidate without a complete second review", async () => {
    const root = await writeReviewProject(await temporaryDir());
    const snapshot = await scan(root);
    const model = stub((body, index) => {
      if (!index) return reviewDiscovery();
      const message = body.messages as { content: { text: string }[] }[];
      const data = JSON.parse(message[0]?.content[0]?.text ?? "{}");
      return reviewDecision(
        data.candidates.map((item: { id: string }) => item.id),
        "dismissed",
      );
    });
    const review = await reviewProject(
      snapshot,
      { scanId: "scan", provider, access },
      model.dispatch,
    );
    expect(review.findings[0]?.validation).toBe("dismissed");
    const invalid = stub((_body, index) =>
      index ? { status: "completed", reason: null, decisions: [] } : reviewDiscovery(),
    );
    const failure = await reviewProject(
      snapshot,
      { scanId: "scan", provider, access },
      invalid.dispatch,
    );
    expect(failure.status).toBe("failed");
    expect(failure.findings).toEqual([]);
    expect(invalid.bodies).toHaveLength(2);
  });

  it("redacts source and provider secrets before transmission and uses snippets only from submitted source", async () => {
    const root = await writeReviewProject(await temporaryDir());
    const secret = "sk-ant-api03-7ZxK8vM2pQa4T9cL6nR1wU3yV5bH0fG2";
    await writeFile(
      join(root, "key.ts"),
      `const apiKey = "${secret}";\nconst other = "${access.apiKey}";\n`,
    );
    const model = stub();
    const result = await reviewProject(
      await scan(root),
      { scanId: "scan", provider, access },
      model.dispatch,
    );
    expect(result.status).toBe("completed");
    for (const encoded of [JSON.stringify(model.bodies), JSON.stringify(result)]) {
      expect(encoded).not.toContain(secret);
      expect(encoded).not.toContain(access.apiKey);
    }
    expect(JSON.stringify(model.bodies)).toContain("<redacted>");
  });

  it("does not follow links, send ignored files or new files outside the saved scan, and reports partial coverage", async () => {
    const root = await writeReviewProject(await temporaryDir());
    await writeFile(join(root, "large.ts"), "// bounded source context\n".repeat(1000));
    const snapshot = await scan(root);
    await writeFile(join(root, "new.ts"), 'const text = "not-in-snapshot";');
    const outside = join(await temporaryDir(), "outside.ts");
    await writeFile(outside, 'const text = "outside-marker";');
    await symlink(outside, join(root, "linked.ts"));
    await writeFile(join(root, ".gitignore"), "store.ts\n");
    const { context, scope } = await captureReviewSource(snapshot, []);
    const encoded = JSON.stringify(context.files);
    expect(encoded).not.toContain("outside-marker");
    expect(encoded).not.toContain("not-in-snapshot");
    expect(encoded).not.toContain("findUnique");
    expect(scope).toMatchObject({ partial: true, omittedFiles: 2, files: [{ path: "server.ts" }] });
  });

  it("stops on refusal or invalid evidence and does not make a second call when discovery found nothing", async () => {
    const snapshot = await scan(await writeReviewProject(await temporaryDir()));
    const refused = stub(() => ({
      ...reviewDiscovery(),
      status: "refused",
      reason: "Declined",
      findings: [],
      stride: [],
    }));
    const refusal = await reviewProject(
      snapshot,
      { scanId: "scan", provider, access },
      refused.dispatch,
    );
    expect(refusal.status).toBe("refused");
    expect(refused.bodies).toHaveLength(1);
    const empty = stub(() => ({ ...reviewDiscovery(), findings: [] }));
    expect(
      (await reviewProject(snapshot, { scanId: "scan", provider, access }, empty.dispatch)).status,
    ).toBe("completed");
    expect(empty.bodies).toHaveLength(1);
    const malicious = reviewDiscovery();
    required(required(malicious.findings[0], "finding").evidence[0], "evidence").path =
      "../outside.ts";
    const model = stub(() => malicious);
    const failure = await reviewProject(
      snapshot,
      { scanId: "scan", provider, access },
      model.dispatch,
    );
    expect(failure.status).toBe("failed");
    expect(failure.findings).toEqual([]);
    expect(model.bodies).toHaveLength(1);
  });

  it("requires all six STRIDE categories once and scope-valid citations for identified threats", () => {
    const files = [
      { path: "server.ts", lines: 7, digest: "" },
      { path: "store.ts", lines: 4, digest: "" },
    ];
    const incomplete = reviewDiscovery();
    incomplete.stride.pop();
    expect(() => parseReviewDiscovery(JSON.stringify(incomplete), files)).toThrow();
    const duplicate = reviewDiscovery();
    duplicate.stride[1] = required(duplicate.stride[0], "STRIDE category");
    expect(() => parseReviewDiscovery(JSON.stringify(duplicate), files)).toThrow();
    const unsupported = reviewDiscovery();
    const threat = required(
      unsupported.stride.find((item) => item.status === "identified"),
      "identified threat",
    );
    threat.evidence = [];
    expect(() => parseReviewDiscovery(JSON.stringify(unsupported), files)).toThrow();
    threat.evidence = [
      { path: "../outside.ts", line: 1, endLine: 1, role: "source", message: "Out of scope" },
    ];
    expect(() => parseReviewDiscovery(JSON.stringify(unsupported), files)).toThrow();
  });

  it("bounds context and refuses a saved source path replaced by a symlink", async () => {
    const root = await writeReviewProject(await temporaryDir());
    for (let i = 0; i < SECURITY_REVIEW_LIMITS.files + 2; i++)
      await writeFile(join(root, `module-${i}.ts`), `export const field${i} = ${i};\n`);
    const snapshot = await scan(root);
    const { context, scope } = await captureReviewSource(snapshot, []);
    expect(context.files).toHaveLength(SECURITY_REVIEW_LIMITS.files);
    expect(Buffer.byteLength(JSON.stringify(context.files))).toBeLessThanOrEqual(
      SECURITY_REVIEW_LIMITS.contextBytes,
    );
    expect(scope.partial).toBe(true);
    expect(scope.omittedFiles).toBe(4);
    const outside = join(await temporaryDir(), "private.ts");
    await writeFile(outside, 'const secret = "outside-private-marker";');
    await rm(join(root, "server.ts"));
    await symlink(outside, join(root, "server.ts"));
    const changed = await captureReviewSource(snapshot, []);
    expect(changed.context.files.some((file) => file.path === "server.ts")).toBe(false);
    expect(JSON.stringify(changed.context.files)).not.toContain("outside-private-marker");
  });

  it("validates exact evidence ranges and decision ids rather than trusting model provenance", () => {
    const files = [
      { path: "server.ts", lines: 7, digest: "" },
      { path: "store.ts", lines: 4, digest: "" },
    ];
    for (const patch of [
      { path: "/etc/passwd" },
      { line: 0 },
      { endLine: 100 },
      { line: 5, endLine: 2 },
    ]) {
      const value = reviewDiscovery();
      Object.assign(
        required(required(value.findings[0], "finding").evidence[0], "evidence"),
        patch,
      );
      expect(() => parseReviewDiscovery(JSON.stringify(value), files)).toThrow();
    }
    expect(() =>
      parseReviewValidation(JSON.stringify(reviewDecision(["invented"])), ["real"]),
    ).toThrow();
    expect(() =>
      parseReviewValidation(JSON.stringify(reviewDecision(["real", "real"])), ["real"]),
    ).toThrow();
  });
});
