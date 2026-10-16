import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { selectExcerpt } from "../src/assessment/review-excerpt.ts";
import { type ReviewSourceFile, SECURITY_REVIEW_LIMITS } from "../src/assessment/review-model.ts";
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
      "1 file was submitted as excerpts of selected functions. Their omitted lines were not reviewed.",
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
