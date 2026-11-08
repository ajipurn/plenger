import { describe, expect, it } from "vitest";
import { PROOF_SESSION_LIMITS } from "../src/redteam/constants.ts";
import type { ProofRunInput, ProofRunResult } from "../src/redteam/proof-model.ts";
import {
  type ProofReadTools,
  type ProofSessionOptions,
  proofSession,
} from "../src/redteam/proof-session.ts";
import {
  ModelProviderFailureError,
  type ModelReply,
  type ModelRequest,
} from "../src/redteam/provider.ts";

const marker = `PLENGER_${"d".repeat(32)}`;
const TEST = "import tools\n\ndef test_intended(plenger):\n    pass\n";

function runResult(
  outcome: ProofRunResult["outcome"],
  reason = `${outcome} reason`,
): ProofRunResult {
  return {
    outcome,
    reason,
    marker,
    cases: [
      {
        name: "weakness",
        status: "passed",
        failedAt: null,
        error: null,
        output: `x`.repeat(PROOF_SESSION_LIMITS.caseTextBytes + 100),
        effects: [
          {
            kind: "file",
            operation: "open",
            target: `/tmp/proof/outside-${marker}/canary.txt`,
            guarded: true,
            shell: false,
            innermost: { path: "tools.py", line: 4 },
            outermost: { path: "tools.py", line: 3 },
          },
        ],
        effectsDropped: 0,
        reached: { "tools.py": [3, 4] },
        replaced: [],
        canary: false,
      },
    ],
    evidence: [],
    runtime: null,
    isolationChecks: [],
  };
}

/** A model that answers each turn from a script; the last answer repeats. */
function scripted(turns: (ModelReply | Error)[]) {
  const requests: ModelRequest[] = [];
  let index = 0;
  return {
    requests,
    send: async (request: ModelRequest): Promise<ModelReply> => {
      requests.push(structuredClone(request));
      const turn = turns[Math.min(index++, turns.length - 1)] as ModelReply | Error;
      if (turn instanceof Error) throw turn;
      return turn;
    },
  };
}

function call(name: string, args: Record<string, unknown>, id = name): ModelReply {
  return { content: null, toolCalls: [{ id, name, arguments: args }] };
}

const readTools: ProofReadTools & { calls: string[] } = {
  calls: [],
  definitions: [{ type: "function", function: { name: "read_file", parameters: {} } }],
  async run(name, args) {
    this.calls.push(`${name}:${String(args.path)}`);
    return { text: "1: def read_note(name):" };
  },
};

function options(
  send: ProofSessionOptions["send"],
  run: (input: ProofRunInput) => Promise<ProofRunResult>,
): ProofSessionOptions {
  return {
    image: `sha256:${"e".repeat(64)}`,
    family: "python",
    finding: {
      title: "Path traversal in read_note",
      weakness: "CWE-22",
      summary: "A note name can climb out of the notes folder.",
      attackPath: "Model chooses the name.",
      validation: "source-supported: no check",
      evidence: [{ path: "tools.py", line: 3, endLine: 4, snippet: "open(name)" }],
    },
    entries: { ranges: [{ path: "tools.py", line: 2, endLine: 4 }], via: "inventory" },
    cited: [{ path: "tools.py", line: 3, endLine: 4 }],
    sources: [{ path: "tools.py", content: "x = 1\n" }],
    files: [{ path: "tools.py", text: "1: from langchain_core.tools import tool" }],
    tools: readTools,
    send,
    tokens: { used: () => 0, limit: PROOF_SESSION_LIMITS.tokens },
    run,
  };
}

describe("proof session", () => {
  it("reads, runs, fixes and stops at the first Proven run", async () => {
    readTools.calls = [];
    const model = scripted([
      call("read_file", { path: "tools.py" }),
      call("run_test", { source: TEST }),
      call("run_test", { source: `${TEST}# fixed\n` }),
      call("give_up", { reason: "never reached" }),
    ]);
    const inputs: ProofRunInput[] = [];
    const outcomes = [
      runResult("could-not-run", "The test did not reach the entry lines."),
      runResult("proven"),
    ];
    const result = await proofSession(
      options(model.send, async (input) => {
        inputs.push(input);
        return outcomes[inputs.length - 1] as ProofRunResult;
      }),
    );
    expect(result).toMatchObject({
      outcome: "proven",
      reason: "proven reason",
      record: { stop: "proven", modelCalls: 3 },
    });
    expect(result.deciding?.test).toBe(`${TEST}# fixed\n`);
    expect(result.runs).toHaveLength(2);
    expect(readTools.calls).toEqual(["read_file:tools.py"]);
    // The host's entry and citations go to every run, whatever the model writes.
    expect(inputs[1]).toMatchObject({
      family: "python",
      weakness: "CWE-22",
      entry: [{ path: "tools.py", line: 2, endLine: 4 }],
      cited: [{ path: "tools.py", line: 3, endLine: 4 }],
    });
    // The model sees what happened, never the marker, and only the output's tail.
    const seen = JSON.stringify(model.requests.at(-1)?.messages);
    expect(seen).not.toContain(marker);
    expect(seen).toContain("tools.py:4");
    expect(seen).toContain("The test did not reach the entry lines.");
    expect(
      model.requests[0]?.tools?.map(
        (item) => (item as { function: { name: string } }).function.name,
      ),
    ).toEqual(["read_file", "run_test", "give_up"]);
    const system = JSON.stringify(model.requests[0]?.messages[0]);
    expect(system).toContain("plenger.shell_payloads()");
    expect(system).toContain("langchain-core");
  });

  it("keeps the last run's outcome when the model gives up", async () => {
    const model = scripted([
      call("run_test", { source: TEST }),
      call("give_up", { reason: "The code resolves the path and checks it; it looks safe." }),
    ]);
    const result = await proofSession(options(model.send, async () => runResult("not-reproduced")));
    expect(result).toMatchObject({
      outcome: "not-reproduced",
      record: {
        stop: "gave-up",
        gaveUp: "The code resolves the path and checks it; it looks safe.",
      },
    });
  });

  it("is Could not run when the model gives up before any test", async () => {
    const model = scripted([call("give_up", { reason: "It needs boto3." })]);
    const result = await proofSession(options(model.send, async () => runResult("proven")));
    expect(result).toMatchObject({
      outcome: "could-not-run",
      reason: "The model gave up before any test ran. It needs boto3.",
      deciding: null,
    });
  });

  it("stops after its runs and keeps the last outcome", async () => {
    const model = scripted([call("run_test", { source: TEST })]);
    let runs = 0;
    const result = await proofSession(
      options(model.send, async () => {
        runs++;
        return runResult("not-reproduced");
      }),
    );
    expect(runs).toBe(PROOF_SESSION_LIMITS.runs);
    expect(result).toMatchObject({ outcome: "not-reproduced", record: { stop: "runs" } });
  });

  it("asks for a last test near its model calls, then stops", async () => {
    readTools.calls = [];
    const model = scripted([call("read_file", { path: "tools.py" })]);
    const result = await proofSession(options(model.send, async () => runResult("proven")));
    expect(result).toMatchObject({
      outcome: "could-not-run",
      record: { stop: "model-calls", modelCalls: PROOF_SESSION_LIMITS.modelCalls },
    });
    expect(JSON.stringify(model.requests.at(-1)?.messages)).toContain(
      "near its limit (model-calls)",
    );
    // The read asked for after the closing notice is refused.
    expect(readTools.calls).toHaveLength(PROOF_SESSION_LIMITS.modelCalls - 1);
  });

  it("ends on a provider policy failure as a refusal, and rethrows other failures", async () => {
    const declined = scripted([new ModelProviderFailureError("OpenAI", "cyber_policy")]);
    const result = await proofSession(options(declined.send, async () => runResult("proven")));
    expect(result).toMatchObject({
      outcome: "could-not-run",
      reason: "The provider refused the request (cyber_policy) before any test ran.",
      record: { stop: "refused", refusal: "cyber_policy", modelCalls: 1 },
    });
    const broken = scripted([new ModelProviderFailureError("OpenAI", "server_error")]);
    await expect(
      proofSession(options(broken.send, async () => runResult("proven"))),
    ).rejects.toThrow("server_error");
  });

  it("stops on a refusal, on silence and on its token limit", async () => {
    const refused = scripted([{ content: null, toolCalls: [], refusal: "no" }]);
    expect(
      (await proofSession(options(refused.send, async () => runResult("proven")))).record.stop,
    ).toBe("refused");
    const silent = scripted([{ content: "I think it is vulnerable.", toolCalls: [] }]);
    const quiet = await proofSession(options(silent.send, async () => runResult("proven")));
    expect(quiet.record).toMatchObject({ stop: "invalid", modelCalls: 3 });
    const broke = scripted([call("run_test", { source: TEST })]);
    const spent = await proofSession({
      ...options(broke.send, async () => runResult("proven")),
      tokens: { used: () => PROOF_SESSION_LIMITS.tokens, limit: PROOF_SESSION_LIMITS.tokens },
    });
    expect(spent).toMatchObject({
      outcome: "could-not-run",
      record: { stop: "tokens", modelCalls: 0 },
    });
  });

  it("discards one reply cut at the output limit", async () => {
    const cut = Object.assign(new Error("cut"), { outputLimit: true });
    const model = scripted([cut, call("run_test", { source: TEST })]);
    const result = await proofSession(options(model.send, async () => runResult("proven")));
    expect(result).toMatchObject({ outcome: "proven", record: { cutReplies: 1, modelCalls: 2 } });
    const twice = scripted([cut, cut]);
    await expect(
      proofSession(options(twice.send, async () => runResult("proven"))),
    ).rejects.toThrow("cut");
  });

  it("needs an entry", async () => {
    const model = scripted([call("give_up", { reason: "x" })]);
    await expect(
      proofSession({
        ...options(model.send, async () => runResult("proven")),
        entries: { ranges: [], via: null },
      }),
    ).rejects.toThrow("needs an entry");
  });
});
