import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReviewFinding, SecurityReview } from "../src/assessment/review-model.ts";
import type { ScanResult } from "../src/scan.ts";
import { scanFindings, vanishedStaticFindings } from "../src/security/findings.ts";
import {
  findingValidation,
  type SecurityFinding,
  type SecurityScan,
} from "../src/security/model.ts";
import { DashboardStore } from "../src/storage/store.ts";
import { temporaryDir } from "./support/tmp.ts";

function job(id: string, repositoryId = "repo"): SecurityScan {
  return {
    id,
    repositoryId,
    sourceScanId: `source-${id}`,
    startedAt: "2026-10-16T00:00:00.000Z",
    finishedAt: null,
    durationMs: 0,
    status: "completed",
    phase: "finished",
    initiatedBy: "Local user",
    scope: "local",
    depth: "standard",
    provider: null,
    revision: { commit: null, branch: null, dirty: null },
    environment: { name: "Local workspace", notes: "" },
    findingCount: 0,
    modelCalls: 0,
    tokens: null,
    error: null,
    findings: [],
    reviews: [],
  };
}

function aiFinding(title: string, line: number, category = "Information disclosure") {
  return {
    id: `candidate-${title}`,
    title,
    severity: "high",
    confidence: "high",
    cwe: "CWE-639",
    category,
    description: "The lookup omits the tenant.",
    impact: "Cross-tenant read.",
    preconditions: [],
    mitigation: "Scope the query.",
    validation: "source-supported",
    validationReason: "Cited source.",
    evidence: [
      { path: "store.ts", line, endLine: line + 1, role: "sink", message: "Query", snippet: "" },
    ],
  } as ReviewFinding;
}

function review(findings: ReviewFinding[]): SecurityReview {
  return { id: `review-${findings.length}`, status: "completed", findings } as SecurityReview;
}

const empty = { findings: [] } as unknown as ScanResult;

describe("AI finding identity", () => {
  it("keeps a saved identity when the model retitles the same issue", () => {
    const [first] = scanFindings(
      job("one"),
      empty,
      [],
      [review([aiFinding("Invoice lookup omits tenant authorization", 2)])],
    );
    const [second] = scanFindings(
      job("two"),
      empty,
      [],
      [review([aiFinding("Invoice lookup lacks tenant scoping", 3)])],
      first ? [first] : [],
    );
    expect(second?.id).toBe(first?.id);
    expect(second?.category).toBe("Information disclosure");
  });

  it("gives distinct issues their own identities", () => {
    const saved = scanFindings(job("one"), empty, [], [review([aiFinding("Tenant leak", 2)])]);
    const next = scanFindings(
      job("two"),
      empty,
      [],
      [
        review([
          aiFinding("Tenant leak again", 2),
          aiFinding("Unrelated tampering", 2, "Tampering"),
        ]),
      ],
      saved,
    );
    expect(next.map((item) => item.id)).toEqual([saved[0]?.id, expect.any(String)]);
    expect(next[1]?.id).not.toBe(saved[0]?.id);
  });
});

describe("finding lifecycle", () => {
  const scanned = (paths: string[], skipped: string[] = []) =>
    ({
      truncated: false,
      files: paths.map((path) => ({ path })),
      skipped: skipped.map((path) => ({ path })),
    }) as unknown as ScanResult;
  const staticFinding = (id: string, path: string) =>
    ({ id, origin: "static", evidence: [{ path }] }) as unknown as SecurityFinding;

  it("resolves only static findings that a complete scan no longer reports", () => {
    const previous = [
      staticFinding("gone", "a.py"),
      staticFinding("kept", "a.py"),
      staticFinding("skipped", "big.py"),
      { ...staticFinding("ai", "a.py"), origin: "ai" } as SecurityFinding,
    ];
    const current = [staticFinding("kept", "a.py")];
    expect(vanishedStaticFindings(previous, current, scanned(["a.py"], ["big.py"]))).toEqual([
      "gone",
    ]);
    expect(
      vanishedStaticFindings(previous, current, { ...scanned(["a.py"]), truncated: true }),
    ).toEqual([]);
    expect(vanishedStaticFindings(previous, current, scanned([]))).toEqual([]);
  });

  it("reopens a resolved finding that is detected again and keeps dismissals", async () => {
    const store = await DashboardStore.open(join(await temporaryDir(), "data"));
    try {
      const project = await temporaryDir();
      const repository = store.security.add(
        project,
        "Project",
        { commit: null, branch: null, dirty: null },
        { name: "Local workspace", notes: "" },
      );
      const first = job("one", repository.id);
      first.findings = scanFindings(
        first,
        empty,
        [],
        [review([aiFinding("Tenant leak", 2), aiFinding("Replay", 9, "Tampering")])],
      );
      store.security.saveFindings(first);
      const [leak, replay] = first.findings;
      store.security.findingStatus(leak?.id ?? "", "resolved");
      store.security.findingStatus(replay?.id ?? "", "dismissed");
      const second = job("two", repository.id);
      second.findings = scanFindings(
        second,
        empty,
        [],
        [review([aiFinding("Tenant leak", 2), aiFinding("Replay", 9, "Tampering")])],
        store.security.findings(repository.id),
      );
      store.security.saveFindings(second);
      const statuses = Object.fromEntries(
        store.security.findings(repository.id).map((item) => [item.id, item.status]),
      );
      expect(statuses).toEqual({ [leak?.id ?? ""]: "new", [replay?.id ?? ""]: "dismissed" });
    } finally {
      store.close();
    }
  });

  it("marks vanished findings resolved without touching closed ones", async () => {
    const store = await DashboardStore.open(join(await temporaryDir(), "data"));
    try {
      const repository = store.security.add(
        await temporaryDir(),
        "Project",
        { commit: null, branch: null, dirty: null },
        { name: "Local workspace", notes: "" },
      );
      const first = job("one", repository.id);
      first.findings = scanFindings(
        first,
        empty,
        [],
        [review([aiFinding("Tenant leak", 2), aiFinding("Replay", 9, "Tampering")])],
      );
      store.security.saveFindings(first);
      const [leak, replay] = first.findings;
      store.security.findingStatus(replay?.id ?? "", "dismissed");
      const second = job("two", repository.id);
      store.security.saveFindings(second, [leak?.id ?? "", replay?.id ?? ""]);
      const saved = store.security.findings(repository.id);
      expect(saved.find((item) => item.id === leak?.id)?.status).toBe("resolved");
      expect(saved.find((item) => item.id === replay?.id)?.status).toBe("dismissed");
    } finally {
      store.close();
    }
  });
});

describe("historical static validation", () => {
  it("reads earlier history as unvalidated and preserves triage when a rescan adds explicit validation fields", async () => {
    const store = await DashboardStore.open(join(await temporaryDir(), "data"));
    try {
      const repo = store.security.add(
        await temporaryDir(),
        "Legacy",
        { commit: null, branch: null, dirty: null },
        { name: "Local workspace", notes: "" },
      );
      const result = {
        findings: [
          {
            fingerprint: "legacy-static",
            rule: "PLG801",
            title: "Request command reaches shell",
            severity: "high",
            confidence: "high",
            notes: [],
            evidence: [],
            location: { path: "server.ts", line: 4, endLine: 4 },
          },
        ],
      } as unknown as ScanResult;
      const first = job("old", repo.id);
      first.findings = scanFindings(first, result, [], []);
      const legacy = first.findings[0];
      if (!legacy) throw new Error("No finding.");
      delete legacy.validationStatus;
      delete legacy.provenance;
      legacy.validation =
        "Static rule indication. Review the cited source; no runtime validation was performed.";
      store.security.saveFindings(first);
      store.security.findingStatus(legacy.id, "triaged");
      expect(findingValidation(store.security.findings(repo.id)[0] ?? legacy)).toBe("unvalidated");
      expect(store.security.scan("old")?.findings[0]).not.toHaveProperty("validationStatus");
      const next = job("new", repo.id);
      next.findings = scanFindings(next, result, [], [], store.security.findings(repo.id));
      store.security.saveFindings(next);
      expect(next.findings[0]).toMatchObject({
        id: legacy.id,
        status: "triaged",
        validationStatus: "unvalidated",
        provenance: [{ origin: "static", ruleId: "PLG801" }],
      });
      expect(store.security.scan("old")?.findings[0]?.validation).toBe(legacy.validation);
    } finally {
      store.close();
    }
  });
});
