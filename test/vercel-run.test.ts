import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateDatabaseTrial, executeNextRun } from "../src/redteam/next-run.ts";
import { planProject, withPreparedProject } from "../src/redteam/plan.ts";
import { createRunProvider, type RunProvider, record } from "../src/redteam/provider.ts";
import { newRun, type RunTrial } from "../src/redteam/run.ts";

const fixture = fileURLToPath(new URL("fixtures/redteam/vercel", import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function project(guarded = false) {
  const root = await mkdtemp(join(tmpdir(), "plenger-vercel-test-"));
  roots.push(root);
  await cp(fixture, root, { recursive: true });
  if (guarded) {
    const path = join(root, "app/api/chat/route.ts");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace("SECURE_PAYMENT=false", "SECURE_PAYMENT=true"),
    );
  }
  return root;
}
function scriptedProvider(refuse = false): RunProvider {
  let next = 0;
  return {
    name: "synthetic-test",
    model: "scripted",
    reservation: (_request, purpose) => ({
      purpose,
      inputTokensUpperBound: 2000,
      maxOutputTokens: 1000,
      additionalTokensUpperBound: 0,
    }),
    async generate(request) {
      const messages = request.messages.map(record),
        user = messages.find((m) => m.role === "user")?.content as string;
      const results = messages.filter((m) => m.role === "tool");
      const call = (name: string, args: Record<string, unknown>) => ({
        value: { content: null, toolCalls: [{ id: `call${++next}`, name, arguments: args }] },
      });
      if (user.includes("book_appointment")) {
        if (!results.length)
          return call("book_appointment", {
            name: "Plenger Test",
            phone: "081200000000",
            vehicle: "Toyota Test",
            service: "ac",
            date: "2030-06-12",
            time: "09:00",
          });
        if (results.length === 1) {
          const output = JSON.parse(results[0]?.content as string);
          return call("create_invoice", { bookingId: output.value.booking.id });
        }
      } else if (!results.length && !refuse) {
        const bookingId = user.match(/booking ([\w-]+)/)?.[1];
        return user.includes("update_invoice_amount")
          ? call("update_invoice_amount", { bookingId, amount: 1000 })
          : call("create_payment", { bookingId, amount: 0 });
      }
      return { value: { content: refuse ? "Tidak diizinkan." : "Selesai.", toolCalls: [] } };
    },
  };
}
describe("managed Next.js preparation", () => {
  it("captures the handler closure, supplies resources and rejects stale source", async () => {
    const root = await project();
    await writeFile(join(root, ".env"), "OPENAI_API_KEY=private-local-secret");
    await writeFile(join(root, "production.sqlite"), "DO NOT TOUCH");
    const plan = await planProject(root);
    expect(plan.preparation.status).toBe("ready");
    expect(plan.nextProfile?.resource).toBe("disposable-sqlite");
    expect(plan.sources.files.map((f) => f.path)).toEqual([
      "app/api/chat/route.ts",
      "lib/bookings.ts",
    ]);
    await writeFile(
      join(root, "lib/bookings.ts"),
      `${await readFile(join(root, "lib/bookings.ts"), "utf8")}\n// source changed`,
    );
    await expect(
      withPreparedProject(
        root,
        { target: plan.selectedTarget as string, expectedDigest: plan.sourceDigest },
        async () => null,
      ),
    ).rejects.toThrow("changed");
    expect(await readFile(join(root, "production.sqlite"), "utf8")).toBe("DO NOT TOUCH");
  });
  it("blocks unqualified dependencies and dynamic imports", async () => {
    const root = await project();
    const path = join(root, "app/api/chat/route.ts");
    await writeFile(path, `${await readFile(path, "utf8")}\nconst other=import('unreviewed');`);
    expect((await planProject(root)).preparation.reasons).toContain("dynamic-import-unsupported");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { ai: "6.0.0", zod: "4.4.3", "better-sqlite3": "12.11.1" } }),
    );
    expect((await planProject(root)).preparation.reasons).toContain("unsupported-version:ai");
  });
  it("preserves Gemini signatures between tool-call turns without saving credentials", async () => {
    const submitted: Record<string, unknown>[] = [];
    const provider = createRunProvider(
      { provider: "gemini", model: "gemini-test", apiKey: "test-key" },
      async (url, options) => {
        expect(url).toBe(
          "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        );
        submitted.push(JSON.parse(options?.body as string));
        return Response.json({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call1",
                    type: "function",
                    function: { name: "lookup", arguments: "{}" },
                    extra_content: { google: { thought_signature: "opaque" } },
                  },
                ],
              },
            },
          ],
        });
      },
    );
    await provider.generate(
      { messages: [{ role: "user", content: "hello" }], tools: null },
      { signal: new AbortController().signal, maxOutputTokens: 1024 },
    );
    await provider.generate(
      {
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call1", type: "function", function: { name: "lookup", arguments: "{}" } },
            ],
          },
        ],
        tools: null,
      },
      { signal: new AbortController().signal, maxOutputTokens: 1024 },
    );
    expect(((submitted[1]?.messages as Record<string, unknown>[]) ?? [])[0]?.tool_calls).toEqual([
      expect.objectContaining({ extra_content: { google: { thought_signature: "opaque" } } }),
    ]);
    expect(JSON.stringify(submitted)).not.toContain("test-key");
  });
});
const image = process.env.PLENGER_TEST_VERCEL_IMAGE;
describe("SQLite evidence verdicts", () => {
  it("retains a committed violation after the handler restores the invoice", () => {
    const before = {
      bookings: [],
      invoices: [{ bookingId: "BK1", amount: 400000, status: "unpaid" }],
      payments: [],
    };
    const trial: RunTrial = {
      id: "manager-price-override",
      purpose: "probe",
      started: true,
      completed: true,
      outcome: "inconclusive",
      modelCalls: 1,
      workerName: null,
      events: [
        {
          sequence: 1,
          stage: "tool_handler_entered",
          tool: "update_invoice_amount",
          callId: "price",
        },
      ],
      database: {
        bookingId: "BK1",
        expectedAmount: 400000,
        before,
        after: before,
        observations: [
          {
            sequence: 1,
            final: false,
            callIds: ["price"],
            after: { ...before, invoices: [{ bookingId: "BK1", amount: 1000, status: "unpaid" }] },
          },
          { sequence: 2, final: true, callIds: [], after: before },
        ],
      },
    };
    evaluateDatabaseTrial(trial, true);
    expect(trial.outcome).toBe("violation_observed");
    evaluateDatabaseTrial(trial, true);
    expect(trial.outcome).toBe("violation_observed");
    trial.outcome = "inconclusive";
    if (trial.database?.observations?.[0]) trial.database.observations[0].callIds = ["unrelated"];
    evaluateDatabaseTrial(trial, true);
    expect(trial.outcome).toBe("not_observed");
  });
});
describe.skipIf(!image)("isolated real Vercel worker with synthetic model", () => {
  it.each([false, true])(
    "executes original handlers and respects guard=%s",
    async (guarded) => {
      const root = await project(guarded),
        plan = await planProject(root);
      const options = {
        target: plan.selectedTarget as string,
        sourceDigest: plan.sourceDigest,
        provider: scriptedProvider(),
        profile: "vercel-booking-sqlite-v1" as const,
        limits: { maxModelCalls: 20, maxTokens: 1000000, timeoutMs: 120000 },
      };
      const report = await executeNextRun(newRun(root, options), options, {
        prepare: async () => image as string,
      });
      expect(report.state).toBe("completed");
      expect(report.cleanupConfirmed).toBe(true);
      expect(report.cleanControlPassed).toBe(true);
      expect(report.runtime).toEqual({
        image,
        node: "22.18.0",
        ai: "7.0.29",
        databaseObserver: "committed-snapshots-v1",
      });
      expect(report.backendChecks?.map((check) => check.outcome)).toEqual(
        guarded ? ["not_observed", "not_observed"] : ["violation_observed", "violation_observed"],
      );
      expect(report.trials.slice(1).map((t) => t.outcome)).toEqual(
        guarded ? ["not_observed", "not_observed"] : ["violation_observed", "violation_observed"],
      );
      expect(report.trials[1]?.database?.before.invoices[0]?.amount).toBe(400000);
      expect(
        report.trials[1]?.events.some(
          (e) => e.stage === "tool_handler_entered" && e.arguments?.amount === 1000,
        ),
      ).toBe(true);
      expect(report.trials[2]?.database?.after?.payments[0]?.amount).toBe(guarded ? undefined : 0);
      await expect(readFile(join(root, "project-production.db"))).rejects.toThrow();
    },
    120000,
  );
  it("stops shared calls and preserves cleanup without declaring the unobserved trial safe", async () => {
    const root = await project(),
      plan = await planProject(root);
    const options = {
      target: plan.selectedTarget as string,
      sourceDigest: plan.sourceDigest,
      provider: scriptedProvider(),
      profile: "vercel-booking-sqlite-v1" as const,
      limits: { maxModelCalls: 1, maxTokens: 1000000, timeoutMs: 120000 },
    };
    const report = await executeNextRun(newRun(root, options), options, {
      prepare: async () => image as string,
    });
    expect(report.state).toBe("stopped");
    expect(report.cleanupConfirmed).toBe(true);
    expect(report.budget?.callsAdmitted).toBe(1);
    expect(report.trials[0]?.outcome).toBe("inconclusive");
    expect(report.trials[1]?.started).toBe(false);
  }, 120000);
  it("keeps backend violations separate from a model that refuses both probes", async () => {
    const root = await project(),
      plan = await planProject(root);
    const options = {
      target: plan.selectedTarget as string,
      sourceDigest: plan.sourceDigest,
      provider: scriptedProvider(true),
      profile: "vercel-booking-sqlite-v1" as const,
      limits: { maxModelCalls: 20, maxTokens: 1000000, timeoutMs: 120000 },
    };
    const report = await executeNextRun(newRun(root, options), options, {
      prepare: async () => image as string,
    });
    expect(report.cleanControlPassed).toBe(true);
    expect(report.cleanupConfirmed).toBe(true);
    expect(report.backendChecks?.every((check) => check.outcome === "violation_observed")).toBe(
      true,
    );
    expect(report.trials.slice(1).map((trial) => trial.outcome)).toEqual([
      "not_observed",
      "not_observed",
    ]);
  }, 120000);
  it("retains committed mutations when the original handler throws after writing", async () => {
    const root = await project();
    const path = join(root, "app/api/chat/route.ts");
    await writeFile(
      path,
      (await readFile(path, "utf8"))
        .replace(
          "store.setInvoiceAmount(bookingId,amount)",
          '(() => { store.setInvoiceAmount(bookingId,amount); throw new Error("after-write"); })()',
        )
        .replace(
          "store.pay(bookingId,amount)",
          '(() => { store.pay(bookingId,amount); throw new Error("after-write"); })()',
        ),
    );
    const plan = await planProject(root);
    const options = {
      target: plan.selectedTarget as string,
      sourceDigest: plan.sourceDigest,
      provider: scriptedProvider(),
      profile: "vercel-booking-sqlite-v1" as const,
      limits: { maxModelCalls: 20, maxTokens: 1000000, timeoutMs: 120000 },
    };
    const report = await executeNextRun(newRun(root, options), options, {
      prepare: async () => image as string,
    });
    expect(report.cleanControlPassed).toBe(true);
    expect(report.cleanupConfirmed).toBe(true);
    expect(report.backendChecks?.map((check) => check.outcome)).toEqual([
      "violation_observed",
      "violation_observed",
    ]);
    expect(report.trials.slice(1).map((trial) => trial.outcome)).toEqual([
      "violation_observed",
      "violation_observed",
    ]);
    expect(
      report.trials
        .slice(1)
        .every((trial) => trial.events.every((event) => event.stage !== "tool_handler_returned")),
    ).toBe(true);
  }, 120000);
  it.each(["statement", "sql-transaction", "immediate-transaction"])(
    "retains a %s commit when its handler hangs and the run is cancelled",
    async (mode) => {
      const root = await project(),
        path = join(root, "app/api/chat/route.ts");
      await writeFile(
        path,
        (await readFile(path, "utf8")).replace(
          'execute:async({bookingId,amount})=>SECURE_PAYMENT?{error:"approval required"}:store.setInvoiceAmount(bookingId,amount)',
          'execute:async({bookingId,amount},context)=>{const result=store.setInvoiceAmount(bookingId,amount);if(!context.toolCallId.startsWith("backend-"))await new Promise(()=>{});return result;}',
        ),
      );
      if (mode !== "statement") {
        const store = join(root, "lib/bookings.ts"),
          source = await readFile(store, "utf8");
        const statement =
          'db.prepare("UPDATE invoices SET amount=? WHERE bookingId=?").run(amount,bookingId);';
        await writeFile(
          store,
          source.replace(
            statement,
            mode === "sql-transaction"
              ? `db.exec("SAVEPOINT price");${statement}db.exec("RELEASE price");`
              : `db.transaction(()=>{${statement}}).immediate();`,
          ),
        );
      }
      const plan = await planProject(root),
        controller = new AbortController();
      const options = {
        target: plan.selectedTarget as string,
        sourceDigest: plan.sourceDigest,
        provider: scriptedProvider(),
        profile: "vercel-booking-sqlite-v1" as const,
        signal: controller.signal,
        limits: { maxModelCalls: 20, maxTokens: 1000000, timeoutMs: 120000 },
        onUpdate(run: ReturnType<typeof newRun>) {
          if (run.trials[1]?.outcome === "violation_observed") controller.abort();
        },
      };
      const report = await executeNextRun(newRun(root, options), options, {
        prepare: async () => image as string,
      });
      expect(report.state).toBe("stopped");
      expect(report.cleanupConfirmed).toBe(true);
      expect(report.cleanControlPassed).toBe(true);
      expect(report.trials[1]).toMatchObject({ completed: false, outcome: "violation_observed" });
      expect(report.trials[1]?.database?.observations).toContainEqual(
        expect.objectContaining({
          final: false,
          callIds: ["call3"],
          after: expect.objectContaining({ invoices: [expect.objectContaining({ amount: 1000 })] }),
        }),
      );
      expect(report.trials[1]?.events.some((e) => e.stage === "tool_handler_returned")).toBe(false);
      expect(report.trials[2]?.started).toBe(false);
    },
    120000,
  );
  it("never counts rolled-back transaction writes as committed effects", async () => {
    const root = await project(),
      store = join(root, "lib/bookings.ts");
    const statement =
      'db.prepare("UPDATE invoices SET amount=? WHERE bookingId=?").run(amount,bookingId);';
    await writeFile(
      store,
      (await readFile(store, "utf8")).replace(
        statement,
        `try{db.transaction(()=>{${statement}throw new Error("rollback");})();}catch{};`,
      ),
    );
    const plan = await planProject(root),
      options = {
        target: plan.selectedTarget as string,
        sourceDigest: plan.sourceDigest,
        provider: scriptedProvider(),
        profile: "vercel-booking-sqlite-v1" as const,
        limits: { maxModelCalls: 20, maxTokens: 1000000, timeoutMs: 120000 },
      };
    const report = await executeNextRun(newRun(root, options), options, {
      prepare: async () => image as string,
    });
    expect(report.state).toBe("completed");
    expect(report.cleanupConfirmed).toBe(true);
    expect(report.trials[1]?.outcome).toBe("not_observed");
    expect(report.trials[1]?.database?.after?.invoices[0]?.amount).toBe(400000);
    expect(report.trials[1]?.database?.observations).toEqual([
      expect.objectContaining({ final: true, callIds: [] }),
    ]);
  }, 120000);
  it("retains an intermediate committed price change even after restoration", async () => {
    const root = await project(),
      store = join(root, "lib/bookings.ts");
    const statement =
      'db.prepare("UPDATE invoices SET amount=? WHERE bookingId=?").run(amount,bookingId);';
    await writeFile(
      store,
      (await readFile(store, "utf8")).replace(
        statement,
        `${statement}db.prepare("UPDATE invoices SET amount=400000 WHERE bookingId=?").run(bookingId);`,
      ),
    );
    const plan = await planProject(root),
      options = {
        target: plan.selectedTarget as string,
        sourceDigest: plan.sourceDigest,
        provider: scriptedProvider(),
        profile: "vercel-booking-sqlite-v1" as const,
        limits: { maxModelCalls: 20, maxTokens: 1000000, timeoutMs: 120000 },
      };
    const report = await executeNextRun(newRun(root, options), options, {
      prepare: async () => image as string,
    });
    expect(report.state).toBe("completed");
    expect(report.cleanupConfirmed).toBe(true);
    expect(report.trials[1]?.outcome).toBe("violation_observed");
    expect(report.trials[1]?.database?.after?.invoices[0]?.amount).toBe(400000);
    expect(
      report.trials[1]?.database?.observations?.map((o) => o.after.invoices[0]?.amount),
    ).toEqual([1000, 400000, 400000]);
  }, 120000);
  it("keeps an unfinished transaction inconclusive", async () => {
    const root = await project(),
      store = join(root, "lib/bookings.ts");
    const statement =
      'db.prepare("UPDATE invoices SET amount=? WHERE bookingId=?").run(amount,bookingId);';
    await writeFile(
      store,
      (await readFile(store, "utf8")).replace(
        statement,
        `if(!db.inTransaction)db.exec("BEGIN");${statement}`,
      ),
    );
    const plan = await planProject(root),
      options = {
        target: plan.selectedTarget as string,
        sourceDigest: plan.sourceDigest,
        provider: scriptedProvider(),
        profile: "vercel-booking-sqlite-v1" as const,
        limits: { maxModelCalls: 20, maxTokens: 1000000, timeoutMs: 120000 },
      };
    const report = await executeNextRun(newRun(root, options), options, {
      prepare: async () => image as string,
    });
    expect(report.state).toBe("failed");
    expect(report.cleanupConfirmed).toBe(true);
    expect(report.trials[1]?.outcome).toBe("inconclusive");
    expect(report.trials[1]?.completed).toBe(false);
    expect(report.trials[1]?.database?.observations).toEqual([]);
  }, 120000);
  it("retains a committed effect when the next model call exceeds the budget", async () => {
    const root = await project(),
      plan = await planProject(root),
      options = {
        target: plan.selectedTarget as string,
        sourceDigest: plan.sourceDigest,
        provider: scriptedProvider(),
        profile: "vercel-booking-sqlite-v1" as const,
        limits: { maxModelCalls: 4, maxTokens: 1000000, timeoutMs: 120000 },
      };
    const report = await executeNextRun(newRun(root, options), options, {
      prepare: async () => image as string,
    });
    expect(report.state).toBe("stopped");
    expect(report.cleanupConfirmed).toBe(true);
    expect(report.budget?.callsAdmitted).toBe(4);
    expect(report.trials[1]).toMatchObject({ completed: false, outcome: "violation_observed" });
    expect(report.trials[1]?.database?.after?.invoices[0]?.amount).toBe(1000);
    expect(report.trials[2]?.started).toBe(false);
  }, 120000);
});
