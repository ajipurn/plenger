import {
  access,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { reviewDependencies } from "../src/redteam/dependencies.ts";
import { planProject, withPreparedProject } from "../src/redteam/plan.ts";
import { readProjectFile } from "../src/redteam/project-files.ts";

const temporary: string[] = [];
const source = `from llmfy import LLMfy, OpenAIChatModel
agent = LLMfy(OpenAIChatModel(model="gpt-4o-mini"))
def chat(message: str):
    return agent.invoke(message).result.content
`;
async function project(files: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "plenger-plan-test-")));
  temporary.push(root);
  for (const [path, value] of Object.entries({
    "agent.py": source,
    "requirements.txt": "llmfy==0.11.0\n",
    ...files,
  })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), value);
  }
  return root;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("offline project preparation", () => {
  it("reviews unsupported Vercel routes without treating them as executable targets", async () => {
    const root = await project({
      "agent.py": "",
      "app/api/chat/route.ts": `import { streamText, tool } from "ai";
const tools = { lookup: tool({ execute: async ({ id }) => id }) };
export async function POST(req: Request) {
  const { messages } = await req.json();
  return streamText({ model: "test", messages, tools });
}`,
    });
    const plan = await planProject(root);
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]?.status).toBe("unsupported");
    expect(plan.preparation.status).toBe("blocked");
    expect(plan.executionReady).toBe(false);
    expect(plan.coverage).toMatchObject({
      files: 2,
      agentDeclarations: 0,
      toolUsingCalls: 1,
      httpEntryPoints: [
        expect.objectContaining({ method: "POST", path: "/api/chat", toolUsing: true }),
      ],
    });
    expect(plan.sources.files.map((file) => file.path)).toEqual(["app/api/chat/route.ts"]);
  });
  it("automatically selects the only candidate and creates a deterministic non-executable plan", async () => {
    const root = await project();
    const first = await planProject(root);
    expect(await planProject(root)).toEqual(first);
    expect(first).toMatchObject({
      kind: "redteam-project-plan",
      executionReady: false,
      selection: "automatic",
      preparation: { status: "ready" },
    });
    expect(first.selectedTarget).toBe(first.targets[0]?.id);
    expect(first.dependencies).toMatchObject({
      resolved: false,
      llmfy: { version: "0.11.0", matchesSyntheticBaseline: true },
    });
    expect(first.sources.files.map((file) => file.path)).toEqual(["agent.py"]);
    await withPreparedProject(root, { expectedDigest: first.sourceDigest }, async (_path, plan) => {
      expect(plan.sourceDigest).toBe(first.sourceDigest);
    });
  });

  it("requires a choice among targets and rejects an absent or unsupported selection", async () => {
    const root = await project({
      "agent.py": `${source}\ndef second(message):\n    return agent.invoke(message)\n`,
    });
    const plan = await planProject(root);
    expect(plan.selection).toBe("required");
    expect(plan.preparation.reasons).toContain("target-selection-required");
    const id = plan.targets[1]?.id as string;
    expect((await planProject(root, { target: id })).selectedTarget).toBe(id);
    await expect(planProject(root, { target: "missing" })).rejects.toThrow("absent or unsupported");
  });

  it("copies only allowed Python bytes, protects file modes, never imports, and always cleans up", async () => {
    const root = await project({
      "agent.py": `${source}\nraise RuntimeError('must not import')\n`,
      "package/data.py": "data = 1\n",
      ".env": "PASSWORD=never-copy-this",
      "data.json": '{"private": "data"}',
      "node_modules/vendor.py": "private = 1",
      "ignored.py": "ignore_me = 1",
      ".gitignore": "ignored.py\n",
    });
    let workspace = "";
    await withPreparedProject(root, {}, async (path, plan) => {
      workspace = path;
      expect(path.startsWith(root)).toBe(false);
      expect((await readdir(path)).sort()).toEqual(["agent.py", "package"]);
      expect(await readFile(join(path, "agent.py"), "utf8")).toContain("must not import");
      expect(plan.sources.omitted).toContainEqual({ path: "ignored.py", reason: "gitignored" });
      if (process.platform !== "win32") {
        expect((await stat(path)).mode & 0o777).toBe(0o700);
        expect((await stat(join(path, "agent.py"))).mode & 0o777).toBe(0o400);
      }
    });
    await expect(access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      withPreparedProject(root, {}, async (path) => {
        workspace = path;
        throw new Error("runner failed");
      }),
    ).rejects.toThrow("runner failed");
    await expect(access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never copies linked files or directories and refuses a snapshot with unresolved source gaps", async () => {
    const root = await project();
    const outside = await project({ "external.py": "secret = 'outside'" });
    await symlink(join(outside, "external.py"), join(root, "linked.py"));
    await symlink(outside, join(root, "directory-link"));
    await link(join(outside, "external.py"), join(root, "hardlinked.py"));
    const plan = await planProject(root);
    expect(plan.sources.omitted).toEqual(
      expect.arrayContaining([
        { path: "linked.py", reason: "symlink" },
        { path: "directory-link", reason: "symlink" },
        { path: "hardlinked.py", reason: "not-a-single-regular-file" },
      ]),
    );
    await expect(
      withPreparedProject(root, {}, async () => {
        throw new Error("callback must not run");
      }),
    ).rejects.toThrow("source-preparation-gaps");
    await expect(readProjectFile(root, "../outside", 100)).rejects.toThrow("outside-project");
    await expect(readProjectFile(root, "directory-link/agent.py", 10000)).rejects.toThrow(
      "linked-path",
    );
  });

  it("blocks recognised credentials instead of altering application code or exposing their values", async () => {
    const secret = "sk-proj-Q8mVr2Bp7Zd4Ta9Xe1Ls6Yw5Nc3Hj0Fq";
    const root = await project({
      "access.py": `API_KEY = "${secret}"`,
      "short.py": 'password = "hunter2"',
      ".private/helper.py": "x = 1",
    });
    const plan = await planProject(root);
    expect(plan.sources.omitted).toEqual(
      expect.arrayContaining([
        { path: "access.py", reason: "embedded-credential" },
        { path: "short.py", reason: "embedded-credential" },
        { path: ".private/helper.py", reason: "sensitive-source-path" },
      ]),
    );
    expect(JSON.stringify(plan)).not.toContain(secret);
    expect(await readFile(join(root, "access.py"), "utf8")).toContain(secret);
    expect(plan.preparation.status).toBe("blocked");
  });

  it("reports syntax errors, invalid encoding, source size and total byte limits", async () => {
    const root = await project({ "bad.py": "broken =\n" });
    await writeFile(join(root, "binary.py"), Buffer.from([0xff, 0xfe]));
    const plan = await planProject(root);
    expect(plan.preparation.reasons).toContain("source-syntax-errors");
    expect(plan.sources.omitted).toContainEqual({ path: "binary.py", reason: "not-utf8-text" });
    expect((await planProject(root, { maxFileBytes: 10 })).sources.omitted).toContainEqual({
      path: "agent.py",
      reason: "too_large",
    });
    expect((await planProject(root, { maxTotalBytes: 10 })).sources.omitted).toContainEqual({
      path: "agent.py",
      reason: "total-byte-limit",
    });
    expect((await planProject(root, { maxFiles: 1 })).sources.truncated).toBe(true);
    await expect(planProject(root, { maxFiles: 0 })).rejects.toThrow("maxFiles");
  });

  it("detects changed source or manifest when preparing a reviewed plan", async () => {
    const root = await project();
    const plan = await planProject(root);
    await writeFile(join(root, "agent.py"), `${source}\n# changed\n`);
    await expect(
      withPreparedProject(root, { expectedDigest: plan.sourceDigest }, async () => 1),
    ).rejects.toThrow("changed since planning");
    const updated = await planProject(root);
    await writeFile(join(root, "requirements.txt"), "llmfy==0.11.0\npydantic==2.13.5\n");
    await expect(
      withPreparedProject(root, { expectedDigest: updated.sourceDigest }, async () => 1),
    ).rejects.toThrow("changed since planning");
  });

  it("keeps source digests stable after relocation and ignores ambient environment files", async () => {
    const first = await planProject(await project({ ".env": "secret-one" }));
    const second = await planProject(
      await project({ ".env": "secret-two", "data.json": "private-resource" }),
    );
    expect(first.sourceDigest).toBe(second.sourceDigest);
    expect(second.sources.resources).toBe("not-collected");
    expect(JSON.stringify(second)).not.toContain("secret-two");
  });
});

describe("dependency review", () => {
  it("reads PEP 621 metadata without running builds and retains extras/constraints", async () => {
    const root = await project({
      "pyproject.toml":
        '[project]\nname="sample"\nrequires-python=">=3.11"\ndependencies=["llmfy[openai]==0.11.0", "pydantic>=2,<3"]\n[build-system]\nrequires=["private-builder"]\nbuild-backend="dangerous.build"\n',
    });
    const report = await reviewDependencies(root);
    expect(report.status).toBe("declared");
    expect(report.requiresPython).toBe(">=3.11");
    expect(report.packages).toContainEqual({
      name: "llmfy",
      extras: ["openai"],
      constraint: "==0.11.0",
      source: "pyproject.toml",
    });
    expect(JSON.stringify(report)).not.toContain("dangerous.build");
  });

  it.each([
    ["llmfy>=0.11.0", "llmfy-version-unresolved"],
    ["llmfy==0.10.0", "llmfy-version-not-qualified"],
    ["-r outside.txt", "unsupported-dependency-declaration"],
    ["llmfy @ https://private.example/package.whl", "unsupported-dependency-declaration"],
    ['llmfy==0.11.0; python_version >= "3.11"', "unsupported-dependency-declaration"],
  ])("retains unsupported requirements: %s", async (entry, reason) => {
    const report = await reviewDependencies(await project({ "requirements.txt": entry }));
    expect(report.issues.some((item) => item.reason === reason)).toBe(true);
    expect(report.resolved).toBe(false);
  });

  it("reports invalid TOML, secrets, custom sources and conflicting declarations without raw values", async () => {
    const root = await project({
      "pyproject.toml":
        '[project]\ndependencies=["llmfy==0.10.0"]\n[tool.uv.sources]\nllmfy={path="../private"}\n',
    });
    let report = await reviewDependencies(root);
    expect(report.issues.map((item) => item.reason)).toEqual(
      expect.arrayContaining([
        "custom-dependency-source-not-supported",
        "llmfy-version-unresolved",
        "conflicting-dependency:llmfy",
      ]),
    );
    await writeFile(join(root, "pyproject.toml"), 'invalid TOML : "must-not-echo"');
    report = await reviewDependencies(root);
    expect(report.issues).toContainEqual({ path: "pyproject.toml", reason: "invalid-toml" });
    expect(JSON.stringify(report)).not.toContain("must-not-echo");
    await rm(join(root, "requirements.txt"));
    await symlink("missing", join(root, "requirements.txt"));
    expect(
      (await reviewDependencies(root)).manifests.find((item) => item.path === "requirements.txt")
        ?.status,
    ).not.toBe("read");
  });

  it("does not emit embedded manifest credentials or accept linked manifests", async () => {
    const credential = "sk-proj-A7mQr3Tp9Za5Vx1Ls8Hd6Nw2Bc4Fj0Ee";
    const root = await project({ "pyproject.toml": `[tool.custom]\napi_key="${credential}"` });
    const report = await reviewDependencies(root);
    expect(report.issues).toContainEqual({ path: "pyproject.toml", reason: "embedded-credential" });
    expect(JSON.stringify(report)).not.toContain(credential);
    await rm(join(root, "pyproject.toml"));
    await symlink("missing", join(root, "pyproject.toml"));
    expect((await reviewDependencies(root)).status).toBe("needs-attention");
  });
});

it("exposes plan JSON in the CLI and validates target-only options", async () => {
  const root = await project();
  const stdout: string[] = [];
  const io = { stdout: (text: string) => stdout.push(text), stderr: () => {}, color: false };
  expect(await main(["redteam", "plan", root, "--json"], io)).toBe(0);
  expect(JSON.parse(stdout.join(""))).toMatchObject({
    kind: "redteam-project-plan",
    executionReady: false,
  });
  expect(await main(["redteam", "plan", root, "--target", "unknown"], io)).toBe(2);
  expect(await main(["redteam", "discover", root, "--target", "unknown"], io)).toBe(2);
  expect(await main(["scan", root, "--target", "unknown"], io)).toBe(2);
  expect(await main(["redteam", "plan", root, "--format", "sarif"], io)).toBe(2);
});
