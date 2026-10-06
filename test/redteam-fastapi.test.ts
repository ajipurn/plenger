import { cp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli/index.ts";
import {
  FASTAPI_ISOLATION_CHECKS,
  FASTAPI_SERVICES,
  FASTAPI_WORKER,
  WORKER_PROTOCOL_VERSION,
} from "../src/redteam/constants.ts";
import * as preparation from "../src/redteam/fastapi-prepare.ts";
import {
  type FastapiDependencies,
  type FastapiPreparation,
  prepareFastapiProject,
} from "../src/redteam/fastapi-prepare.ts";
import { formatProjectPlan, PreparationError, planProject } from "../src/redteam/plan.ts";
import { runBlocker } from "../src/redteam/profile.ts";
import { networkArguments, serviceRunArguments } from "../src/redteam/services.ts";
import {
  containerArguments,
  type FastapiWorkerLauncher,
  type FastapiWorkerOptions,
} from "../src/redteam/worker.ts";
import { fixturePath } from "./support/fixtures.ts";
import { temporaryDir } from "./support/tmp.ts";

const fixture = fixturePath("redteam/fastapi");

async function copyFixture(files: Record<string, string | null> = {}) {
  const root = await temporaryDir("plenger-fastapi-");
  await cp(fixture, root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    if (content === null) await rm(join(root, path));
    else await writeFile(join(root, path), content);
  }
  return root;
}

const ready = {
  type: "ready",
  protocolVersion: WORKER_PROTOCOL_VERSION,
  python: "3.12.13",
  llmfy: "0.6.0",
  packages: [{ name: "fastapi", version: "0.115.14" }],
  isolationChecks: [...FASTAPI_ISOLATION_CHECKS],
};

function stubs(worker: FastapiWorkerLauncher) {
  let disposed = 0;
  const dependencies: FastapiDependencies = {
    prepare: async () => ({
      image: `docker:sha256:${"a".repeat(64)}`,
      platform: "linux/amd64",
      engine: "docker",
    }),
    services: async (_engine, names) => ({
      network: "plenger-services-test",
      services: names.map((name) => ({
        name,
        image: FASTAPI_SERVICES[name].image,
        host: name,
        port: FASTAPI_SERVICES[name].port,
        ready: true,
      })),
      env: { MYSQL_HOST: "mysql", REDIS_HOST: "redis" },
      dispose: async () => {
        disposed += 1;
        return true;
      },
    }),
    worker,
  };
  return { dependencies, disposed: () => disposed };
}

describe("FastAPI profile planning", () => {
  it("plans the FastAPI profile when the file canary cannot bind an llmfy entry point", async () => {
    const plan = await planProject(fixture);
    expect(plan.fastapiProfile).toMatchObject({
      id: "fastapi-llmfy-v1",
      app: { path: "app/main.py", module: "app.main", attribute: "app" },
      llmfy: { version: "0.6.0", adapter: "available" },
      dependencies: {
        manifest: "requirements.txt",
        declared: 3,
        unpinned: ["websocket-client"],
        policy: "resolve-and-record",
      },
      services: ["mysql", "redis"],
      transport: "asgi-in-process",
    });
    expect(plan.selection).toBe("automatic");
    expect(plan.selectedTarget).toMatch(/^fastapi:/);
    expect(plan.targets.find((target) => target.id === plan.selectedTarget)).toMatchObject({
      framework: "fastapi",
      kind: "app",
      symbol: "app.main:app",
      status: "candidate",
      packs: [],
    });
    // The llmfy baseline check belongs to the file-canary profile, not to this one.
    expect(plan.dependencies.status).toBe("declared");
    // Text resources under the application's packages travel with the code; the root README does not.
    expect(plan.sources.policy).toBe("python-resources-v1");
    expect(plan.sources.files.map((file) => file.path)).toEqual([
      "app/__init__.py",
      "app/agent.py",
      "app/main.py",
      "app/prompts/system.md",
    ]);
    expect(plan.preparation).toEqual({ status: "ready", reasons: [] });
    expect(runBlocker(plan)).toContain("redteam prepare");
    expect(formatProjectPlan(plan)).toContain("app.main:app");
  });

  it("keeps the llmfy profile when a file-canary target binds", async () => {
    const plan = await planProject(fixturePath("redteam/llmfy"));
    expect(plan.fastapiProfile).toBeUndefined();
    expect(plan.sources.policy).toBe("python-only-v1");
    expect(plan.targets.every((target) => target.framework === "llmfy")).toBe(true);
  });

  it("blocks an llmfy version without an adapter and a project without requirements.txt", async () => {
    const unsupported = await copyFixture({
      "requirements.txt": "fastapi==0.115.14\nllmfy==0.5.0\n",
    });
    const plan = await planProject(unsupported);
    expect(plan.fastapiProfile?.llmfy).toEqual({ version: "0.5.0", adapter: "missing" });
    expect(plan.preparation.reasons).toContain("llmfy-adapter-missing:0.5.0");
    const pyproject = await copyFixture({
      "requirements.txt": null,
      "pyproject.toml":
        '[project]\nname = "fixture"\ndependencies = ["fastapi==0.115.14", "llmfy==0.6.0"]\n',
    });
    expect((await planProject(pyproject)).preparation.reasons).toContain(
      "requirements-file-required",
    );
  });
});

describe("FastAPI preparation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds, starts services, imports the application and probes a route without any model call", async () => {
    let launch: { request: Record<string, unknown>; options: FastapiWorkerOptions } | undefined;
    const { dependencies, disposed } = stubs(async (image, request, _signal, receive, options) => {
      launch = { request, options };
      expect(image).toMatch(/^docker:sha256:/);
      await receive(ready);
      await receive({ type: "adapter", llmfy: "0.6.0", patched: ["llmfy.BedrockModel"] });
      await receive({
        type: "imported",
        durationMs: 12,
        application: "FastAPI",
        routes: [{ methods: ["GET"], path: "/" }],
      });
      await receive({ type: "event", stage: "tool_handler_entered", tool: "lookup_order" });
      await receive({ type: "probe", method: "GET", path: "/", status: 200, bytes: 20 });
      await receive({ type: "finished", completed: true });
    });
    const updates: FastapiPreparation["stage"][] = [];
    const report = await prepareFastapiProject(
      fixture,
      {
        onUpdate: (snapshot) => updates.push(snapshot.stage),
        // Service settings win over anything the user supplies; SDK credentials get placeholders.
        settings: { KNOWLEDGE_S3_BUCKET: "plenger-test-bucket", MYSQL_HOST: "elsewhere" },
      },
      dependencies,
    );
    expect(report).toMatchObject({
      kind: "redteam-fastapi-preparation",
      state: "completed",
      stage: "done",
      profile: "fastapi-llmfy-v1",
      runtime: { platform: "linux/amd64", python: "3.12.13", llmfy: "0.6.0" },
      packages: [{ name: "fastapi", version: "0.115.14" }],
      adapter: { llmfy: "0.6.0", patched: ["llmfy.BedrockModel"] },
      imported: { application: "FastAPI", routes: [{ methods: ["GET"], path: "/" }] },
      probe: { method: "GET", path: "/", status: 200 },
      toolEvents: 1,
      modelCalls: 0,
      failure: null,
      cleanupConfirmed: true,
      error: null,
    });
    expect(report.services.map((service) => service.name)).toEqual(["mysql", "redis"]);
    expect(launch?.request).toMatchObject({
      app: { module: "app.main", attribute: "app" },
      llmfy: "0.6.0",
      env: {
        MYSQL_HOST: "mysql",
        REDIS_HOST: "redis",
        KNOWLEDGE_S3_BUCKET: "plenger-test-bucket",
        AWS_ACCESS_KEY_ID: "plenger-placeholder",
      },
      probe: { method: "GET", path: "/" },
    });
    expect(report.settings).toEqual({
      supplied: ["KNOWLEDGE_S3_BUCKET", "MYSQL_HOST"],
      placeholders: expect.arrayContaining(["AWS_ACCESS_KEY_ID", "OPENAI_API_KEY"]),
      services: ["MYSQL_HOST", "REDIS_HOST"],
    });
    expect(JSON.stringify(report)).not.toContain("plenger-test-bucket");
    expect(launch?.request.sources).toHaveLength(4);
    expect(launch?.options).toMatchObject({
      network: "plenger-services-test",
      platform: "linux/amd64",
    });
    expect(updates).toEqual(
      expect.arrayContaining(["plan", "build", "services", "worker", "done"]),
    );
    expect(disposed()).toBe(1);
  });

  it("records an import failure, refuses a model request and a wrong runtime, and always removes services", async () => {
    const failing = stubs(async (_image, _request, _signal, receive) => {
      await receive(ready);
      await receive({
        type: "failure",
        stage: "import",
        error: { type: "ModuleNotFoundError", message: "No module named 'slowapi'" },
      });
      await receive({ type: "finished", completed: false });
    });
    const failed = await prepareFastapiProject(fixture, {}, failing.dependencies);
    expect(failed).toMatchObject({
      state: "failed",
      stage: "worker",
      failure: { stage: "import", error: { type: "ModuleNotFoundError" } },
    });
    expect(failed.error).toContain("slowapi");
    expect(failing.disposed()).toBe(1);

    const model = stubs(async (_image, _request, _signal, receive) => {
      await receive(ready);
      await receive({ type: "model_request", id: 1, messages: [], tools: null });
    });
    const refused = await prepareFastapiProject(fixture, {}, model.dependencies);
    expect(refused).toMatchObject({ state: "failed", failure: { stage: "model-call" } });
    expect(model.disposed()).toBe(1);

    const wrong = stubs(async (_image, _request, _signal, receive) => {
      await receive({ ...ready, llmfy: "0.11.0" });
    });
    expect((await prepareFastapiProject(fixture, {}, wrong.dependencies)).state).toBe("failed");
    expect(wrong.disposed()).toBe(1);
  });

  it("refuses projects outside the profile before building anything", async () => {
    let built = false;
    await expect(
      prepareFastapiProject(
        fixturePath("redteam/llmfy"),
        {},
        {
          prepare: async () => {
            built = true;
            throw new Error("unreachable");
          },
        },
      ),
    ).rejects.toBeInstanceOf(PreparationError);
    expect(built).toBe(false);
  });

  it("exposes the stage through the CLI with exit codes 0, 1 and 2", async () => {
    const run = async (...argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(argv, {
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
        color: false,
      });
      return { code, stdout: out.join(""), stderr: err.join("") };
    };
    expect((await run("redteam", "prepare", fixturePath("redteam/llmfy"))).code).toBe(2);
    expect((await run("redteam", "prepare", "--help")).stdout).toContain("FastAPI profile");
    expect((await run("redteam", "prepare", fixture, "--env", "not-a-name=1")).code).toBe(2);
    expect((await run("redteam", "prepare", fixture, "--env", "PLENGER_X=1")).code).toBe(2);
    expect((await run("redteam", "prepare", fixture, "--env-file", "/nonexistent.env")).code).toBe(
      2,
    );
    // Produce a real report through the stubs first; the spy then stands in for the build.
    const report = await prepareFastapiProject(
      fixture,
      {},
      stubs(async (_image, _request, _signal, receive) => {
        await receive(ready);
        await receive({ type: "adapter", llmfy: "0.6.0", patched: [] });
        await receive({ type: "imported", durationMs: 1, application: "FastAPI", routes: [] });
        await receive({ type: "finished", completed: true });
      }).dependencies,
    );
    const spy = vi.spyOn(preparation, "prepareFastapiProject").mockResolvedValue(report);
    const completed = await run("redteam", "prepare", fixture, "--json");
    expect(completed.code).toBe(0);
    expect(JSON.parse(completed.stdout)).toMatchObject({
      kind: "redteam-fastapi-preparation",
      state: "completed",
    });
    spy.mockResolvedValue({
      ...(JSON.parse(completed.stdout) as FastapiPreparation),
      state: "failed",
      failure: { stage: "build", error: { type: "RuntimeBuildError", message: "no wheel" } },
    });
    const failed = await run("redteam", "prepare", fixture);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain("Failure at build");
  });
});

describe("FastAPI launch arguments", () => {
  it("joins the private service network with the profile's limits and no other network", () => {
    const image = `sha256:${"b".repeat(64)}`;
    const args = containerArguments("docker", image, "plenger-run-1", 1000, {
      runtime: "fastapi",
      projectRequest: {},
      network: "plenger-services-1",
      env: { MYSQL_HOST: "mysql" },
      platform: "linux/amd64",
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "--network=plenger-services-1",
        "--platform=linux/amd64",
        `--memory=${FASTAPI_WORKER.memoryBytes}`,
        `--pids-limit=${FASTAPI_WORKER.pids}`,
        "--env=MYSQL_HOST=mysql",
        "--read-only",
        "--cap-drop=ALL",
        "/opt/plenger/worker.py",
      ]),
    );
    expect(args).not.toContain("--network=none");
    expect(
      containerArguments("docker", image, "plenger-run-2", 1000, {
        runtime: "llmfy",
        projectRequest: {},
      }),
    ).toContain("--network=none");
  });

  it("starts pinned services on an internal network without published ports", () => {
    expect(networkArguments("docker", "plenger-services-1", 1)).toEqual(
      expect.arrayContaining(["network", "create", "--internal", "plenger-services-1"]),
    );
    const mysql = serviceRunArguments("docker", "mysql", {
      container: "plenger-service-mysql-1",
      network: "plenger-services-1",
      expiresAt: Date.now() + 1000,
      env: { MYSQL_ROOT_PASSWORD: "x" },
    });
    expect(mysql).toEqual(
      expect.arrayContaining([
        "--network=plenger-services-1",
        "--network-alias=mysql",
        "--pull=never",
        "--env=MYSQL_ROOT_PASSWORD=x",
        FASTAPI_SERVICES.mysql.image,
      ]),
    );
    expect(mysql.some((arg) => arg === "-p" || arg.startsWith("--publish"))).toBe(false);
    expect(FASTAPI_SERVICES.mysql.image).toMatch(/@sha256:[a-f0-9]{64}$/);
    const redis = serviceRunArguments("podman", "redis", {
      container: "c",
      network: "n",
      expiresAt: Date.now() + 1000,
      env: {},
    });
    expect(redis.slice(-5)).toEqual(["redis-server", "--save", "", "--appendonly", "no"]);
  });
});
