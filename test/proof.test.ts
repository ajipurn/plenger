import { describe, expect, it } from "vitest";
import { PROOF_ISOLATION_CHECKS, WORKER_PROTOCOL_VERSION } from "../src/redteam/constants.ts";
import {
  decideProof,
  type ProofCase,
  type ProofEffect,
  type ProofRunInput,
  parseProofCase,
  proofTestRule,
} from "../src/redteam/proof-model.ts";
import {
  type ProofLauncher,
  proofTestStructure,
  runProofTest,
  validateProofInput,
} from "../src/redteam/proof-run.ts";
import { containerArguments } from "../src/redteam/worker.ts";

const marker = `PLENGER_${"a".repeat(32)}`;
const entry = [{ path: "app.py", line: 10, endLine: 12 }];
const cited = [{ path: "files.py", line: 3, endLine: 5 }];

function effect(overrides: Partial<ProofEffect> = {}): ProofEffect {
  return {
    kind: "file",
    operation: "open",
    target: `/tmp/proof/outside-${marker}/canary.txt`,
    guarded: true,
    shell: false,
    innermost: { path: "files.py", line: 4 },
    outermost: { path: "app.py", line: 11 },
    ...overrides,
  };
}

function testCase(name: ProofCase["name"], overrides: Partial<ProofCase> = {}): ProofCase {
  return {
    name,
    status: "passed",
    failedAt: null,
    error: null,
    output: "",
    effects: [],
    effectsDropped: 0,
    reached: { "app.py": [10, 11] },
    replaced: [],
    canary: false,
    ...overrides,
  };
}

function decide(weakness: "CWE-22" | "CWE-78", attack: Partial<ProofCase>, intended = {}) {
  return decideProof({
    weakness,
    marker,
    entry,
    cited,
    cases: [testCase("intended", intended), testCase("weakness", attack)],
  });
}

describe("proof outcome", () => {
  it("is Proven only for an effect from the cited code reached through the entry", () => {
    const proven = decide("CWE-22", { effects: [effect()] });
    expect(proven.outcome).toBe("proven");
    expect(proven.reason).toBe("files.py:4 reached a file outside its folder (open).");
    // The test called the helper directly instead of going through the entry.
    expect(
      decide("CWE-22", { effects: [effect({ outermost: { path: "files.py", line: 4 } })] }),
    ).toMatchObject({ outcome: "not-reproduced", reason: expect.stringContaining("outside") });
    // The effect came from a file the finding does not cite.
    expect(
      decide("CWE-22", { effects: [effect({ innermost: { path: "app.py", line: 11 } })] }).outcome,
    ).toBe("not-reproduced");
    // No project frame ran the call at all.
    expect(
      decide("CWE-22", { effects: [effect({ innermost: null, outermost: null })] }).outcome,
    ).toBe("not-reproduced");
  });

  it("requires this run's marker and a guarded path", () => {
    const other = `PLENGER_${"b".repeat(32)}`;
    expect(
      decide("CWE-22", { effects: [effect({ target: `/tmp/proof/outside-${other}/canary.txt` })] })
        .outcome,
    ).toBe("not-reproduced");
    expect(decide("CWE-22", { effects: [effect({ guarded: false })] }).outcome).toBe(
      "not-reproduced",
    );
  });

  it("proves command injection only by a shell whose injected command ran", () => {
    const shell = effect({
      kind: "process",
      operation: "subprocess.Popen",
      target: `/bin/sh -c ping ;echo $((1+2))>/tmp/proof/effects/${marker}`,
      guarded: false,
      shell: true,
    });
    expect(decide("CWE-78", { effects: [shell], canary: true }).outcome).toBe("proven");
    expect(decide("CWE-78", { effects: [shell], canary: false }).outcome).toBe("not-reproduced");
    expect(decide("CWE-78", { effects: [{ ...shell, shell: false }], canary: true }).outcome).toBe(
      "not-reproduced",
    );
    // A file effect is not evidence of command injection.
    expect(decide("CWE-78", { effects: [effect()], canary: true }).outcome).toBe("not-reproduced");
  });

  it("refuses a proof that relies on changed code", () => {
    const result = decide("CWE-22", { effects: [effect()], replaced: ["tools.NOTES"] });
    expect(result).toMatchObject({
      outcome: "could-not-run",
      reason: "The test replaced tools.NOTES; a proof cannot rely on changed code.",
    });
  });

  it("says Could not run when the test never reached the entry or the setup failed", () => {
    expect(decide("CWE-22", { reached: { "app.py": [9] } })).toMatchObject({
      outcome: "could-not-run",
      reason: "The test did not reach the entry lines.",
    });
    expect(
      decide("CWE-22", {}, { status: "failed", failedAt: "test", error: "AssertionError: x" }),
    ).toMatchObject({
      outcome: "could-not-run",
      reason: "The intended case failed: AssertionError: x",
    });
    expect(
      decide("CWE-22", {
        status: "error",
        failedAt: "import",
        error: "ModuleNotFoundError: No module named 'boto3'",
      }),
    ).toMatchObject({
      outcome: "could-not-run",
      reason: "The test could not load: ModuleNotFoundError: No module named 'boto3'",
    });
    expect(decide("CWE-22", { status: "timeout" }).outcome).toBe("could-not-run");
  });

  it("says Not reproduced, never safe, when the entry ran without an effect", () => {
    expect(decide("CWE-22", { status: "error", failedAt: "test" })).toEqual({
      outcome: "not-reproduced",
      reason:
        "The entry ran and no effect came from the cited code. This is not evidence of safety.",
      evidence: [],
    });
  });
});

describe("proof frames", () => {
  const frame = {
    type: "case",
    name: "weakness",
    status: "passed",
    failedAt: null,
    error: null,
    output: "",
    effects: [effect()],
    effectsDropped: 0,
    reached: { "app.py": [10] },
    replaced: [],
    canary: false,
  };

  it("accepts a well-formed case frame", () => {
    expect(parseProofCase(frame)).toMatchObject({ name: "weakness", effects: [effect()] });
  });

  it.each([
    ["an unknown name", { name: "cleanup" }],
    ["an unknown status", { status: "skipped" }],
    ["too much output", { output: "x".repeat(8193) }],
    ["a shell flag on a file", { effects: [effect({ shell: true })] }],
    ["a guarded process", { effects: [effect({ kind: "process", guarded: true })] }],
    ["a frame without a line", { effects: [effect({ innermost: { path: "a.py", line: 0 } })] }],
    ["too many effects", { effects: Array.from({ length: 33 }, () => effect()) }],
    ["a missing canary flag", { canary: undefined }],
  ])("rejects %s", (_, overrides) => {
    expect(() => parseProofCase({ ...frame, ...overrides })).toThrow();
  });
});

describe("proof test rules", () => {
  it.each([
    ["python", "import subprocess\n"],
    ["python", "from os import system\n"],
    ["python", "import tools\ndef test_weakness(plenger):\n    open('/etc/passwd')\n"],
    ["python", "def test_weakness(plenger):\n    os.remove(path)\n"],
    ["python", "def test_weakness(plenger):\n    path.read_text()\n"],
    ["python", "import sys\ndef test_weakness(plenger):\n    sys.addaudithook(print)\n"],
    ["python", "def test_weakness(plenger):\n    tools.__dict__['x'] = 1\n"],
    ["python", "PATH = '/tmp/proof/outside-x/canary.txt'\n"],
    ["javascript", 'import { readFileSync } from "node:fs";\n'],
    ["javascript", 'import { execSync } from "node:child_process";\n'],
    ["javascript", "Error.prepareStackTrace = () => [];\n"],
    ["javascript", "const marker = 'PLENGER_';\n"],
    ["javascript", "export async function testWeakness() {\n  process.chdir('/tmp');\n}\n"],
    [
      "python",
      "import contextlib\ndef test_weakness(plenger):\n    with contextlib.chdir('/'):\n        pass\n",
    ],
  ] as const)("refuses %s text that reaches the harness: %j", (family, text) => {
    expect(proofTestRule(family, text)).toEqual(expect.any(String));
  });

  it("accepts tests that only call the project through the helper", () => {
    expect(
      proofTestRule(
        "python",
        'import os\nimport tools\n\ndef test_weakness(plenger):\n    os.environ["ROOT"] = str(plenger.base())\n    tools.run.invoke({"command": "echo" + plenger.shell_payloads()[0]})\n',
      ),
    ).toBeNull();
    expect(
      proofTestRule(
        "javascript",
        'import path from "node:path";\nexport async function testWeakness(plenger) {\n  return path.relative(plenger.base(), plenger.canary());\n}\n',
      ),
    ).toBeNull();
    expect(proofTestRule("python", "x".repeat(16 * 1024 + 1))).toContain("larger than");
  });

  it("allows only imports, functions and literal constants at the top level", async () => {
    expect(
      await proofTestStructure(
        "python",
        '"""Proof."""\nimport tools\nLIMIT = 3\n\ndef test_weakness(plenger):\n    tools.NOTES = 1\n',
      ),
    ).toBeNull();
    expect(
      await proofTestStructure(
        "javascript",
        'import app from "/tmp/project/server.ts";\nconst LIMIT = 3;\nasync function get() {}\nexport async function testWeakness() {}\n',
      ),
    ).toBeNull();
    expect(await proofTestStructure("python", "import tools\ntools.NOTES = 1\n")).toContain(
      "top level",
    );
    expect(
      await proofTestStructure(
        "python",
        "import tools\n@decorate\ndef test_weakness(p):\n    pass\n",
      ),
    ).toContain("top level");
    expect(await proofTestStructure("python", "class Fake:\n    pass\n")).toContain("top level");
    expect(
      await proofTestStructure("javascript", 'import app from "x";\napp.locals.root = "/";\n'),
    ).toContain("top level");
    expect(await proofTestStructure("javascript", "const root = compute();\n")).toContain(
      "top level",
    );
    expect(await proofTestStructure("python", "def broken(:\n")).toBe("The test does not parse.");
  });
});

describe("proof runs", () => {
  const input: ProofRunInput = {
    family: "python",
    weakness: "CWE-22",
    sources: [
      { path: "app.py", content: "x = 1\n" },
      { path: "files.py", content: "y = 2\n" },
    ],
    test: "import app\n\ndef test_intended(plenger):\n    pass\n",
    entry,
    cited,
  };
  const image = `sha256:${"c".repeat(64)}`;
  const ready = {
    type: "ready",
    protocolVersion: WORKER_PROTOCOL_VERSION,
    python: "3.12.13",
    packages: { flask: "3.1.3" },
    isolationChecks: [...PROOF_ISOLATION_CHECKS["proof-python"]],
  };

  /** Replays frames, filling the run's marker into each effect target. */
  function replay(frames: (marker: string) => unknown[]): ProofLauncher {
    return async (_image, runtime, request, onMessage) => {
      expect(runtime).toBe("proof-python");
      for (const frame of frames(request.marker as string)) await onMessage(frame);
    };
  }

  it("decides the outcome from the frames, with a fresh marker", async () => {
    const markers: string[] = [];
    const launch = replay((runMarker) => {
      markers.push(runMarker);
      return [
        ready,
        {
          ...testCase("intended"),
          type: "case",
          output: "token=sk-proj-Q7vX2mN9pL4kR8tW1yZ3bC6dF0gH5jK",
        },
        {
          ...testCase("weakness", {
            effects: [effect({ target: `/tmp/proof/outside-${runMarker}/canary.txt` })],
          }),
          type: "case",
        },
        { type: "finished", completed: true },
      ];
    });
    const result = await runProofTest(image, input, { launch });
    expect(result).toMatchObject({
      outcome: "proven",
      marker: markers[0],
      runtime: { name: "proof-python", version: "3.12.13", packages: { flask: "3.1.3" } },
    });
    expect(result.cases[0]?.output).not.toContain("Q7vX2mN9pL4kR8tW1yZ3bC6dF0gH5jK");
    await runProofTest(image, input, { launch });
    expect(markers[1]).toMatch(/^PLENGER_[a-f0-9]{32}$/);
    expect(markers[1]).not.toBe(markers[0]);
  });

  it("never launches a refused test", async () => {
    let launched = false;
    const result = await runProofTest(
      image,
      { ...input, test: "import subprocess\n" },
      {
        launch: async () => {
          launched = true;
        },
      },
    );
    expect(launched).toBe(false);
    expect(result).toMatchObject({ outcome: "could-not-run", marker: null });
    expect(result.reason).toContain("The host refused the test.");
  });

  it.each([
    ["no ready frame", () => [{ type: "finished", completed: true }]],
    ["a wrong image", () => [{ ...ready, python: "3.11.0" }]],
    ["a missing isolation check", () => [{ ...ready, isolationChecks: ["linux"] }]],
    [
      "cases out of order",
      () => [
        ready,
        { ...testCase("weakness"), type: "case" },
        { type: "finished", completed: true },
      ],
    ],
    ["no finished frame", () => [ready, { ...testCase("intended"), type: "case" }]],
  ])("is Could not run on %s", async (_, frames) => {
    const result = await runProofTest(image, input, {
      launch: async (_image, _runtime, _request, onMessage) => {
        for (const frame of frames()) await onMessage(frame);
      },
    });
    expect(result.outcome).toBe("could-not-run");
  });

  it("rethrows cancellation", async () => {
    const controller = new AbortController();
    await expect(
      runProofTest(image, input, {
        signal: controller.signal,
        launch: async () => {
          controller.abort();
          throw new Error("Worker cancelled.");
        },
      }),
    ).rejects.toThrow("cancelled");
  });

  it("rejects inputs the worker would refuse", () => {
    expect(() => validateProofInput({ ...input, weakness: "CWE-89" as never })).toThrow(
      "do not support",
    );
    expect(() =>
      validateProofInput({ ...input, sources: [{ path: "../app.py", content: "" }] }),
    ).toThrow("source path");
    expect(() =>
      validateProofInput({ ...input, entry: [{ path: "other.py", line: 1, endLine: 2 }] }),
    ).toThrow("entry range");
    expect(() => validateProofInput({ ...input, cited: [] })).toThrow("cited ranges");
  });

  it("launches proof workers with the shared isolation flags and their own entrypoint", () => {
    const python = containerArguments("podman", "sha256:x", "n", 60_000, {
      projectRequest: {},
      runtime: "proof-python",
    });
    expect(python).toEqual(
      expect.arrayContaining(["--network=none", "--read-only", "--cap-drop=ALL"]),
    );
    expect(python).toContain("org.plenger.purpose=proof-test");
    expect(python.slice(-4)).toEqual([
      "--entrypoint=python",
      "sha256:x",
      "-I",
      "/opt/plenger/proof.py",
    ]);
    expect(
      containerArguments("docker", "sha256:x", "n", 60_000, {
        projectRequest: {},
        runtime: "proof-node",
      }).slice(-3),
    ).toEqual(["--entrypoint=node", "sha256:x", "/opt/plenger/proof.mjs"]);
  });
});
