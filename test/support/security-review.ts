import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STRIDE } from "../../src/assessment/model.ts";
import type { ReviewDiscovery } from "../../src/assessment/review-model.ts";

export async function writeReviewProject(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "server.ts"),
    [
      'import { readInvoice } from "./store.ts";',
      "export async function getInvoice(request: any, response: any) {",
      "  if (!request.user) return response.status(401).end();",
      "  const invoice = await readInvoice(request.params.id);",
      "  return response.json(invoice);",
      "}",
      'export function mount(app: any) { app.get("/invoices/:id", getInvoice); }',
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "store.ts"),
    [
      "declare const db: any;",
      "export async function readInvoice(id: string) {",
      "  return db.invoices.findUnique({ where: { id } });",
      "}",
      "",
    ].join("\n"),
  );
  return root;
}

/** Synthetic protocol fixture. It does not measure a real model's detection quality. */
// A model reply: closures arrive as `paths`, which these fixtures leave out.
export function reviewDiscovery(): Omit<ReviewDiscovery, "closures"> {
  return {
    status: "completed",
    reason: null,
    summary:
      "The invoice route authenticates callers but does not restrict the invoice lookup to their tenant.",
    architecture: "An HTTP handler in server.ts calls the invoice data helper in store.ts.",
    assets: ["Private invoice records", "Authenticated user identity"],
    trustBoundaries: [
      "HTTP route parameter to database lookup",
      "One tenant's user to another tenant's invoice",
    ],
    stride: STRIDE.map((category) => ({
      category,
      status: category === "Information disclosure" ? "identified" : "insufficient-context",
      analysis:
        category === "Information disclosure"
          ? "Invoice records cross the user-to-tenant boundary without a visible tenant predicate."
          : `The supplied route and helper do not establish all controls relevant to ${category.toLowerCase()}.`,
      mitigation:
        category === "Information disclosure"
          ? "Scope the data lookup to the authenticated tenant and verify database policies."
          : "Inspect callers, configuration, and deployment controls before drawing a conclusion.",
      evidence:
        category === "Information disclosure"
          ? [
              {
                path: "store.ts",
                line: 2,
                endLine: 3,
                role: "sink",
                message: "The query predicate contains only the invoice id.",
              },
            ]
          : [],
    })),
    findings: [
      {
        title: "Invoice lookup omits tenant authorization",
        severity: "high",
        confidence: "high",
        category: "Information disclosure",
        cwe: "CWE-639",
        description:
          "getInvoice checks that a user exists, then forwards the caller-controlled invoice id to readInvoice. The query uses only id.",
        impact: "An authenticated caller may read an invoice belonging to another tenant.",
        preconditions: [
          "The route is deployed and invoice ids can be obtained or guessed.",
          "No database row policy supplies the missing tenant restriction.",
        ],
        mitigation:
          "Pass the caller's tenant identity into the data helper and include it in the query predicate. Add cross-tenant regression coverage.",
        evidence: [
          {
            path: "server.ts",
            line: 3,
            endLine: 5,
            role: "source",
            message: "The authentication guard does not bind the invoice id to the user or tenant.",
          },
          {
            path: "store.ts",
            line: 2,
            endLine: 3,
            role: "sink",
            message: "The lookup predicate only contains the supplied id.",
          },
        ],
      },
    ],
    limitations: ["Database row policies and deployment configuration were not supplied."],
  };
}

/**
 * One decision per id. A dismissal cites `control` as its guard; without one it names no
 * basis, which the host keeps as needs-review.
 */
export function reviewDecision(
  ids: string[],
  verdict = "source-supported",
  control?: { path: string; line: number; endLine: number },
): unknown {
  const cited = verdict === "dismissed" && control !== undefined;
  return {
    status: "completed",
    reason: null,
    decisions: ids.map((id) => ({
      id,
      verdict,
      reason:
        "server.ts:3 authenticates the caller, while store.ts:3 filters only by invoice id. Tenant policy at the database layer is not visible and requires human review.",
      basis: cited ? "control" : null,
      evidence: cited
        ? [{ ...control, role: "guard", message: "The lookup is limited to the caller's rows." }]
        : [],
      duplicateOf: null,
    })),
  };
}

export function nativeReviewReply(content: unknown, stopReason = "end_turn"): unknown {
  return {
    type: "message",
    role: "assistant",
    stop_reason: stopReason,
    content: [
      { type: "text", text: typeof content === "string" ? content : JSON.stringify(content) },
    ],
    usage: { input_tokens: 500, output_tokens: 500 },
  };
}
