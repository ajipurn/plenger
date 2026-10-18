import type { Session } from "../../auth/session.ts";
import { prisma } from "../../db.ts";
import { HttpError, notFound } from "../../http/middleware/errors.ts";
import { addDays } from "../../lib/dates.ts";
import { amount } from "../../lib/money.ts";
import { audit } from "../audit-log/audit-log.service.ts";
import type { InvoiceDraft } from "./invoices.schema.ts";

export function listInvoices(actor: Session, clientId?: string) {
  return prisma.invoice.findMany({
    where: { workspaceId: actor.workspaceId, ...(clientId ? { clientId } : {}) },
    select: { id: true, number: true, clientId: true, status: true, totalMinor: true, dueOn: true },
    orderBy: { issuedOn: "desc" },
  });
}

/** Bills the approved, billable, not yet invoiced time of one client in a period. */
export async function draftInvoice(actor: Session, draft: InvoiceDraft) {
  const client = await prisma.client.findFirst({
    where: { id: draft.clientId, workspaceId: actor.workspaceId },
  });
  if (!client) throw new HttpError(422, "unknown client");
  const entries = await prisma.timeEntry.findMany({
    where: {
      workspaceId: actor.workspaceId,
      billable: true,
      invoiceId: null,
      timesheet: { status: "approved" },
      project: { clientId: client.id },
      date: { gte: new Date(draft.from), lte: new Date(draft.to) },
    },
    include: { rate: { select: { billableMinor: true } }, project: { select: { name: true } } },
  });
  if (!entries.length) throw new HttpError(422, "nothing to invoice in this period");
  const count = await prisma.invoice.count({ where: { workspaceId: actor.workspaceId } });
  const issuedOn = new Date();
  const invoice = await prisma.invoice.create({
    data: {
      workspaceId: actor.workspaceId,
      clientId: client.id,
      number: `INV-${String(count + 1).padStart(5, "0")}`,
      currency: client.currency,
      status: "draft",
      issuedOn,
      dueOn: addDays(issuedOn, draft.dueInDays),
      totalMinor: entries.reduce(
        (sum, entry) => sum + (entry.rate ? amount(entry.minutes, entry.rate.billableMinor) : 0),
        0,
      ),
      entries: { connect: entries.map((entry) => ({ id: entry.id })) },
    },
  });
  await audit(actor, "invoice.drafted", { type: "invoice", id: invoice.id });
  return invoice;
}

export async function issueInvoice(actor: Session, invoiceId: string) {
  const { count } = await prisma.invoice.updateMany({
    where: { id: invoiceId, workspaceId: actor.workspaceId, status: "draft" },
    data: { status: "issued" },
  });
  if (!count) throw notFound("draft invoice");
  await audit(actor, "invoice.issued", { type: "invoice", id: invoiceId });
}
