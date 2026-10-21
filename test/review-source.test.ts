import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  lineSizes,
  rangeBytes,
  renderedJsonBytes,
  renderSource,
  selectExcerpt,
} from "../src/assessment/review-excerpt.ts";
import {
  batchTokenBound,
  type ReviewSourceFile,
  reviewBudget,
  SECURITY_REVIEW_LIMITS,
} from "../src/assessment/review-model.ts";
import { captureReviewSource } from "../src/assessment/review-source.ts";
import { reviewProject } from "../src/assessment/security-review.ts";
import { scan } from "../src/scan.ts";
import { required } from "./support/dashboard.ts";
import { nativeReviewReply, reviewDecision, reviewDiscovery } from "./support/security-review.ts";
import { temporaryDir } from "./support/tmp.ts";

const access = {
  provider: "anthropic" as const,
  model: "claude-review-test",
  apiKey: "owned-provider-secret-9kV2",
  maxOutputTokens: 8192,
};
const provider = { id: "saved-provider", name: "Claude review", model: access.model };

const SINK = ["def execute(cmd):", "    return subprocess.run(cmd, shell=True)"];

/** An HTTP route in api.py whose command reaches `subprocess.run` in ops.py. */
async function writeRouteProject(root: string, ops: string[]): Promise<string[]> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "api.py"),
    [
      "from fastapi import FastAPI",
      "from ops import execute",
      "",
      "app = FastAPI()",
      "",
      '@app.post("/run")',
      "def run(cmd: str):",
      "    return execute(cmd)",
      "",
    ].join("\n"),
  );
  const lines = ["import subprocess", "", ...ops, ""];
  await writeFile(join(root, "ops.py"), lines.join("\n"));
  return lines;
}

function fillers(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => [
    `def ${prefix}_${index}(value):`,
    `    return value + ${index}`,
    "",
  ]).flat();
}

/** Discovery that cites the route and the given ops.py lines. Synthetic protocol fixture. */
function routeDiscovery(line: number, endLine: number) {
  const value = reviewDiscovery();
  value.stride = value.stride.map((entry) => ({
    ...entry,
    status: "insufficient-context" as const,
    evidence: [],
  }));
  required(value.findings[0], "finding").evidence = [
    { path: "api.py", line: 6, endLine: 8, role: "source", message: "The route forwards cmd." },
    { path: "ops.py", line, endLine, role: "sink", message: "The command runs in a shell." },
  ];
  return value;
}

/** A Go service with a template, configuration, a test, CI and a hidden editor file. */
async function writeGoProject(root: string): Promise<void> {
  const files: Record<string, string> = {
    "handlers/users.go": [
      "package handlers",
      "",
      'import "net/http"',
      "",
      "func GetUser(w http.ResponseWriter, r *http.Request) {",
      '\tid := r.URL.Query().Get("id")',
      '\trows, _ := db.Query("SELECT * FROM users WHERE id = " + id)',
      "\tdefer rows.Close()",
      "}",
      "",
    ].join("\n"),
    "handlers/users_test.go": "package handlers\n",
    "util/strings.go": "package util\n\nfunc Trim(s string) string { return s }\n",
    "config/app.yaml": "listen: 0.0.0.0:8080\n",
    ".github/workflows/ci.yml": "on: pull_request_target\n",
    ".vscode/settings.json": "{}\n",
    "go.sum": "example.com/x v1.0.0 h1:abc=\n",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

function stub(discovery: unknown) {
  const bodies: Record<string, unknown>[] = [];
  const dispatch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    let content = discovery;
    if (bodies.length > 1) {
      const messages = body.messages as { content: { text: string }[] }[];
      const data = JSON.parse(messages[0]?.content[0]?.text ?? "{}");
      content = reviewDecision(data.candidates.map((item: { id: string }) => item.id));
    }
    return new Response(JSON.stringify(nativeReviewReply(content)), { status: 200 });
  };
  return { bodies, dispatch };
}

describe("AI review source selection", () => {
  it("submits the files on an entry point to effect path before security-named files", async () => {
    const root = join(await temporaryDir(), "project");
    await writeRouteProject(root, SINK);
    for (let index = 0; index < 20; index++)
      await writeFile(join(root, `auth_${index}.py`), fillers(`check${index}`, 40).join("\n"));
    const snapshot = await scan(root);
    expect(snapshot.inventory.entryPoints[0]?.reaches[0]?.location.path).toBe("ops.py");
    const { context, scope } = await captureReviewSource(snapshot, []);
    expect(scope.files.slice(0, 2)).toEqual([
      expect.objectContaining({ path: "api.py" }),
      expect.objectContaining({ path: "ops.py" }),
    ]);
    // Small path files are upgraded from excerpts to whole files.
    expect(scope.files.some((file) => file.ranges)).toBe(false);
    expect(context.omitted.length).toBeGreaterThan(0);
    expect(context.omitted.every((item) => item.reason === "Review source budget reached.")).toBe(
      true,
    );
    expect(Buffer.byteLength(JSON.stringify(context.files))).toBeLessThanOrEqual(
      SECURITY_REVIEW_LIMITS.contextBytes,
    );
  });

  it("submits the traced function of a file too large to send whole, with original line numbers", async () => {
    const root = join(await temporaryDir(), "project");
    // The effect is the file's last function, beyond what source order would reach.
    const lines = await writeRouteProject(root, [...fillers("before", 600), ...SINK]);
    const sink = lines.indexOf("def execute(cmd):") + 1;
    expect(Buffer.byteLength(lines.join("\n"))).toBeGreaterThan(SECURITY_REVIEW_LIMITS.fileBytes);
    const snapshot = await scan(root);
    const { context, scope } = await captureReviewSource(snapshot, []);
    const file = required(
      scope.files.find((item) => item.path === "ops.py"),
      "ops.py",
    );
    // The import and the traced function first; spare budget adds leading functions.
    const [leading, traced] = file.ranges ?? [];
    expect(file.ranges).toHaveLength(2);
    expect(leading?.line).toBe(1);
    expect(traced).toEqual({ line: sink, endLine: sink + 1 });
    const gap = (leading?.endLine ?? 0) + 1;
    const source = required(
      context.files.find((item) => item.path === "ops.py"),
      "entry",
    ).source.split("\n");
    expect(source[0]).toBe("1: import subprocess");
    expect(source).toContain("3: def before_0(value):");
    expect(source.slice(-3)).toEqual([
      `… lines ${gap}-${sink - 1} not submitted`,
      `${sink}: def execute(cmd):`,
      `${sink + 1}:     return subprocess.run(cmd, shell=True)`,
    ]);
    expect(scope.partial).toBe(true);

    const model = stub(routeDiscovery(sink, sink + 1));
    const review = await reviewProject(
      snapshot,
      { scanId: "scan", provider, access },
      model.dispatch,
    );
    expect(review.status).toBe("completed");
    expect(review.findings[0]?.evidence[1]?.snippet).toBe(
      `${sink}: def execute(cmd):\n${sink + 1}:     return subprocess.run(cmd, shell=True)`,
    );
    expect(review.limitations).toContain(
      "1 file was submitted as excerpts of selected functions or line windows. Their omitted lines were not reviewed.",
    );
    expect(JSON.stringify(model.bodies[0])).toContain("A file with ranges is an excerpt");
    expect(JSON.stringify(model.bodies[0])).not.toContain("def before_599(");

    // A citation of a line that was not submitted is rejected, even inside the file.
    const omitted = stub(routeDiscovery(gap + 1, gap + 1));
    const rejected = await reviewProject(
      snapshot,
      { scanId: "scan", provider, access },
      omitted.dispatch,
    );
    expect(rejected.status).toBe("failed");
    expect(rejected.reason).toContain("$.findings[0].evidence[1].line");
    expect(rejected.reason).toContain("excerpt range");
  });

  it("keeps the signature and the lines around the effect when its function alone is too large", async () => {
    const root = join(await temporaryDir(), "project");
    const body = Array.from({ length: 700 }, (_, index) => `    step_${index} = cmd + "${index}"`);
    const lines = await writeRouteProject(root, [
      "def execute(cmd):",
      ...body,
      "    return subprocess.run(cmd, shell=True)",
    ]);
    const sink = lines.indexOf("    return subprocess.run(cmd, shell=True)") + 1;
    const { scope } = await captureReviewSource(await scan(root), []);
    expect(scope.files.find((item) => item.path === "ops.py")?.ranges).toEqual([
      { line: 1, endLine: 3 },
      { line: sink - 8, endLine: sink },
    ]);
  });

  it("submits whole top-level definitions in source order from a large file off any traced path", async () => {
    const root = await temporaryDir();
    const helpers = Array.from({ length: 400 }, (_, index) =>
      [
        `export function helper${index}(value: number) {`,
        `  return value + ${index};`,
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "helpers.ts"),
      ['import { join } from "node:path";', "", ...helpers].join("\n"),
    );
    const { context, scope } = await captureReviewSource(await scan(root), []);
    const file = required(scope.files[0], "helpers.ts");
    expect(file.path).toBe("helpers.ts");
    expect(file.ranges?.[0]).toEqual({ line: 1, endLine: expect.any(Number) });
    const source = required(context.files[0], "entry").source;
    expect(source).toContain('1: import { join } from "node:path";');
    expect(source).toContain("export function helper0(value: number) {");
    expect(source).not.toContain("helper399");
    // Every submitted function is complete: each opening line has its closing brace.
    expect(source.match(/export function/g)?.length).toBe(source.match(/^\d+: \}$/gm)?.length);
    expect(Buffer.byteLength(JSON.stringify(context.files))).toBeLessThanOrEqual(
      SECURITY_REVIEW_LIMITS.contextBytes,
    );
  });

  it("continues an excerpted file in later batches with the functions not sent yet", async () => {
    const root = join(await temporaryDir(), "project");
    await writeRouteProject(root, [...fillers("before", 1000), ...SINK]);
    const snapshot = await scan(root);
    const batches: ReviewSourceFile[][] = [];
    for (let batch = 0; batch < 3; batch++)
      batches.push(
        (await captureReviewSource(snapshot, [], undefined, batches.flat())).scope.files,
      );
    expect(batches.map((files) => files.map((file) => file.path))).toEqual([
      ["api.py", "ops.py"],
      ["ops.py"],
      ["ops.py"],
    ]);
    const sent = batches.map((files) => {
      const file = required(
        files.find((item) => item.path === "ops.py"),
        "ops.py",
      );
      return new Set(
        (file.ranges ?? []).flatMap((range) =>
          Array.from({ length: range.endLine - range.line + 1 }, (_, index) => range.line + index),
        ),
      );
    });
    // The import goes again as context; every other line is sent in one batch only.
    for (const [a, b] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const)
      expect([...(sent[a] ?? [])].filter((line) => sent[b]?.has(line))).toEqual([1]);
    expect(sent.every((lines) => lines.size > 100)).toBe(true);
  });

  it("does not continue a file that changed after an earlier batch sent part of it", async () => {
    const root = join(await temporaryDir(), "project");
    const lines = await writeRouteProject(root, [...fillers("before", 600), ...SINK]);
    const snapshot = await scan(root);
    const first = await captureReviewSource(snapshot, []);
    const ops = required(
      first.scope.files.find((item) => item.path === "ops.py"),
      "ops.py",
    );
    expect(ops.ranges).toBeDefined();
    await writeFile(join(root, "ops.py"), lines.join("\n").replace("before_0(", "before_zero("));
    const second = await captureReviewSource(snapshot, [], undefined, [ops]);
    expect(second.scope.files.map((file) => file.path)).toEqual(["api.py"]);
    expect(second.context.omitted).toContainEqual({
      path: "ops.py",
      reason: "Changed after a previous source batch submitted part of it.",
    });
  });

  it("does not revisit a part an earlier batch sent through its wider fallback", () => {
    const parts = [
      { ranges: [{ line: 7, endLine: 7 }], fallback: [{ line: 1, endLine: 15 }] },
      { ranges: [{ line: 30, endLine: 32 }] },
    ];
    expect(selectExcerpt(parts, 40, () => true, [{ line: 7, endLine: 27 }])).toEqual([
      { line: 30, endLine: 32 },
    ]);
  });

  it("sizes the batch to the smallest known model window within the token ceiling", () => {
    const defaults = {
      contextBytes: SECURITY_REVIEW_LIMITS.contextBytes,
      fileBytes: SECURITY_REVIEW_LIMITS.fileBytes,
      files: SECURITY_REVIEW_LIMITS.files,
      relatedBytes: SECURITY_REVIEW_LIMITS.relatedBytes,
      inputTokens: null,
    };
    expect(reviewBudget([])).toEqual(defaults);
    expect(reviewBudget([null])).toEqual(defaults);
    // A validator with an unknown window keeps the defaults too.
    expect(reviewBudget([200_000, undefined])).toEqual(defaults);
    const wide = reviewBudget([200_000]);
    expect(wide).toEqual({
      contextBytes: 105_593,
      fileBytes: SECURITY_REVIEW_LIMITS.maxFileBytes,
      files: SECURITY_REVIEW_LIMITS.maxFiles,
      relatedBytes: 45_254,
      inputTokens: 200_000,
    });
    // Half the 400,000-token ceiling caps every window; the smaller window decides.
    expect(reviewBudget([1_000_000])).toEqual({ ...wide, inputTokens: 1_000_000 });
    expect(reviewBudget([1_000_000, 64_000]).contextBytes).toBe(
      Math.floor((64_000 - SECURITY_REVIEW_LIMITS.outputTokens - 36 * 1024) * 0.7),
    );
    // The larger validation reservation, at one token per byte, fits half the ceiling.
    const validation =
      SECURITY_REVIEW_LIMITS.requestOverheadBytes +
      wide.contextBytes +
      wide.relatedBytes +
      SECURITY_REVIEW_LIMITS.outputTokens;
    expect(2 * validation).toBeLessThanOrEqual(SECURITY_REVIEW_LIMITS.tokens);
  });

  it("submits more source for a model whose window is known, past the trial request limit", async () => {
    const root = join(await temporaryDir(), "project");
    const lines = await writeRouteProject(root, [...fillers("before", 1200), ...SINK]);
    expect(Buffer.byteLength(lines.join("\n"))).toBeGreaterThan(48 * 1024);
    const snapshot = await scan(root);
    const model = stub({ ...routeDiscovery(1, 1), findings: [] });
    const review = await reviewProject(
      snapshot,
      { scanId: "scan", provider, access, inputTokens: 200_000 },
      model.dispatch,
    );
    expect(review.status).toBe("completed");
    expect(review.scope.budget).toMatchObject({ contextBytes: 105_593, inputTokens: 200_000 });
    expect(Buffer.byteLength(JSON.stringify(model.bodies[0]))).toBeGreaterThan(48 * 1024);
    const ops = required(
      review.scope.files.find((file) => file.path === "ops.py"),
      "ops.py",
    );
    const submitted = (ops.ranges ?? [{ line: 1, endLine: ops.lines }]).reduce(
      (sum, range) => sum + range.endLine - range.line + 1,
      0,
    );
    expect(submitted).toBeGreaterThan(2000);
    expect(review.limitations).toContain(
      "The batch budget was 103 KiB of source for a 200,000-token model window, within the 400,000-token review ceiling.",
    );
  });

  it("measures rendered source exactly without rendering it", () => {
    const lines = [
      'const quote = "say \\"hi\\"";',
      "\tconst tab = 1; // café ✓ 🚀",
      "",
      "const control = '\u0001';",
      "export const last = 5;",
      "",
    ];
    const sizes = lineSizes(lines);
    for (const ranges of [
      undefined,
      [{ line: 1, endLine: 1 }],
      [{ line: 2, endLine: 2 }],
      [
        { line: 1, endLine: 2 },
        { line: 4, endLine: 5 },
      ],
      [{ line: 5, endLine: 5 }],
    ]) {
      expect(renderedJsonBytes(sizes, 5, ranges)).toBe(
        Buffer.byteLength(JSON.stringify(renderSource(lines, 5, ranges))),
      );
      const submitted = ranges ?? [{ line: 1, endLine: 5 }];
      expect(rangeBytes(sizes, submitted)).toBe(
        submitted.reduce(
          (sum, range) =>
            sum +
            lines
              .slice(range.line - 1, range.endLine)
              .reduce((bytes, text) => bytes + Buffer.byteLength(text) + 1, 0),
          0,
        ),
      );
    }
  });

  it("reviews a repository in another language as plain text, code before configuration and tests", async () => {
    const root = join(await temporaryDir(), "service");
    await writeGoProject(root);
    // Without listed text files nothing here can be read.
    await expect(captureReviewSource(await scan(root), [])).rejects.toThrow(
      "No source files fit this review.",
    );
    const snapshot = await scan(root, { texts: true });
    expect(snapshot.files).toEqual([]);
    const { context, scope } = await captureReviewSource(snapshot, []);
    expect(scope.files.map((file) => file.path)).toEqual([
      "handlers/users.go",
      "util/strings.go",
      ".github/workflows/ci.yml",
      "config/app.yaml",
      "handlers/users_test.go",
    ]);
    expect(scope.files.some((file) => file.ranges)).toBe(false);
    expect(context.omitted).toEqual([
      { path: ".vscode/settings.json", reason: "Hidden or credential-related path excluded." },
    ]);
    expect(scope.eligibleFiles).toBe(6);
    expect(context.files[0]?.source).toContain(
      '7: \trows, _ := db.Query("SELECT * FROM users WHERE id = " + id)',
    );

    const value = reviewDiscovery();
    value.stride = value.stride.map((entry) => ({
      ...entry,
      status: "insufficient-context" as const,
      evidence: [],
    }));
    required(value.findings[0], "finding").evidence = [
      {
        path: "handlers/users.go",
        line: 6,
        endLine: 7,
        role: "sink",
        message: "The id reaches SQL.",
      },
    ];
    const model = stub(value);
    const review = await reviewProject(
      snapshot,
      { scanId: "scan", provider, access },
      model.dispatch,
    );
    expect(review.status).toBe("completed");
    expect(review.findings[0]?.evidence[0]?.snippet).toBe(
      '6: \tid := r.URL.Query().Get("id")\n7: \trows, _ := db.Query("SELECT * FROM users WHERE id = " + id)',
    );
    expect(review.limitations.join(" ")).toContain(
      "Files without a parser (other languages, templates and configuration) are read as plain text",
    );
  });

  it("reviews traced files under test paths after the other code", async () => {
    const root = join(await temporaryDir(), "project");
    await writeRouteProject(join(root, "tests"), SINK);
    await writeFile(join(root, "util.py"), fillers("util", 2).join("\n"));
    const snapshot = await scan(root);
    expect(snapshot.inventory.entryPoints[0]?.location.path).toBe("tests/api.py");
    const { scope } = await captureReviewSource(snapshot, []);
    expect(scope.files.map((file) => file.path)).toEqual([
      "util.py",
      "tests/api.py",
      "tests/ops.py",
    ]);
  });

  it("sends a large file without a parser in line windows and continues them in later batches", async () => {
    const root = join(await temporaryDir(), "service");
    const lines = Array.from(
      { length: 2400 },
      (_, index) => `\tvalues[${index}] = lookup(${index})`,
    );
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "table.go"), ["package table", ...lines, ""].join("\n"));
    const snapshot = await scan(root, { texts: true });
    const batches: ReviewSourceFile[][] = [];
    for (let batch = 0; batch < 3; batch++)
      batches.push(
        (await captureReviewSource(snapshot, [], undefined, batches.flat())).scope.files,
      );
    const sent = batches.map((files) => required(files[0], "table.go").ranges ?? []);
    // Each batch starts where the previous one stopped, in whole 80-line windows.
    expect(sent[0]?.[0]?.line).toBe(1);
    for (const [index, ranges] of sent.entries()) {
      expect(ranges, `batch ${index}`).toHaveLength(1);
      expect(((ranges[0]?.endLine ?? 0) - (ranges[0]?.line ?? 0) + 1) % 80).toBe(0);
      if (index > 0) expect(ranges[0]?.line).toBe((sent[index - 1]?.[0]?.endLine ?? 0) + 1);
    }
  });

  it("keeps both requests within the batch bound that limits are checked against", async () => {
    const root = join(await temporaryDir(), "project");
    const lines = await writeRouteProject(root, [...fillers("before", 1500), ...SINK]);
    const sink = lines.indexOf("def execute(cmd):") + 1;
    const snapshot = await scan(root);
    for (const window of [undefined, 1_000_000]) {
      const bound = batchTokenBound(reviewBudget([window]));
      const model = stub(routeDiscovery(sink, sink + 1));
      const review = await reviewProject(
        snapshot,
        {
          scanId: "scan",
          provider,
          access,
          inputTokens: window ?? null,
          environment: { name: "Staging", notes: "é".repeat(2000) },
        },
        model.dispatch,
      );
      expect(review.status, String(window)).toBe("completed");
      // Each reservation is the request's bytes plus a 4,096-token margin.
      const [discovery, validation] = model.bodies.map(
        (body) => Buffer.byteLength(JSON.stringify(body)) + 4096,
      );
      expect(discovery).toBeLessThanOrEqual(bound.discovery.prompt);
      expect(validation).toBeLessThanOrEqual(bound.validation.prompt);
      expect(review.request.charged).toEqual({ tokens: 2000, usd: null });
    }
  });

  it("sends no request whose maximum does not fit what remains of the limit", async () => {
    const root = join(await temporaryDir(), "project");
    const lines = await writeRouteProject(root, SINK);
    const sink = lines.indexOf("def execute(cmd):") + 1;
    const snapshot = await scan(root);
    const pricing = {
      model: access.model,
      rates: { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 },
    };
    const run = (limit: Parameters<typeof reviewProject>[1]["limit"]) => {
      const model = stub(routeDiscovery(sink, sink + 1));
      return reviewProject(
        snapshot,
        { scanId: "scan", provider, access, pricing, ...(limit ? { limit } : {}) },
        model.dispatch,
      ).then((review) => ({ review, bodies: model.bodies }));
    };
    for (const limit of [
      { kind: "tokens", tokens: 1000 },
      { kind: "usd", usd: 0.0001 },
    ] as const) {
      const { review, bodies } = await run(limit);
      expect(review).toMatchObject({ status: "failed", request: { calls: 0, limitReached: true } });
      expect(review.reason).toContain(limit.kind === "tokens" ? "token limit" : "USD limit");
      expect(bodies).toHaveLength(0);
    }
    // Within the limit, the batch charges the reported usage at saved prices.
    const { review } = await run({ kind: "usd", usd: 5 });
    expect(review.status).toBe("completed");
    expect(review.request.limitReached).toBeUndefined();
    expect(review.request.charged?.tokens).toBe(2000);
    expect(review.request.charged?.usd).toBeCloseTo(0.012, 12);
  });

  it("does not submit an excerpt that holds only imports", () => {
    const parts = [
      { ranges: [{ line: 20, endLine: 40 }] },
      { ranges: [{ line: 1, endLine: 2 }], supporting: true as const },
    ];
    const lines = (ranges: { line: number; endLine: number }[]) =>
      ranges.reduce((sum, range) => sum + range.endLine - range.line + 1, 0);
    expect(selectExcerpt(parts, 50, (ranges) => lines(ranges) <= 5)).toEqual([]);
    expect(selectExcerpt(parts, 50, (ranges) => lines(ranges) <= 30)).toEqual([
      { line: 1, endLine: 2 },
      { line: 20, endLine: 40 },
    ]);
  });
});
