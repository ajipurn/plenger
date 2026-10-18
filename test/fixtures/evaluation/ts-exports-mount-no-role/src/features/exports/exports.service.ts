import type { Session } from "../../auth/session.ts";
import { prisma } from "../../db.ts";
import { csv } from "../../lib/csv.ts";
import { isoDate } from "../../lib/dates.ts";
import { amount } from "../../lib/money.ts";
import type { ExportRange } from "./exports.schema.ts";

export async function payrollCsv(actor: Session, range: ExportRange) {
  const entries = await prisma.timeEntry.findMany({
    where: {
      workspaceId: actor.workspaceId,
      date: { gte: new Date(range.from), lte: new Date(range.to) },
    },
    include: {
      user: { select: { name: true, email: true } },
      project: { select: { name: true, client: { select: { name: true } } } },
      rate: { select: { billableMinor: true, costMinor: true } },
    },
    orderBy: [{ userId: "asc" }, { date: "asc" }],
  });
  return csv(
    ["date", "member", "email", "client", "project", "minutes", "billable", "cost_rate", "cost", "revenue"],
    entries.map((entry) => [
      isoDate(entry.date),
      entry.user.name,
      entry.user.email,
      entry.project.client.name,
      entry.project.name,
      entry.minutes,
      entry.billable,
      entry.rate?.costMinor,
      entry.rate ? amount(entry.minutes, entry.rate.costMinor) : null,
      entry.rate && entry.billable ? amount(entry.minutes, entry.rate.billableMinor) : null,
    ]),
  );
}

export async function membersCsv(actor: Session) {
  const members = await prisma.membership.findMany({
    where: { workspaceId: actor.workspaceId },
    include: {
      user: {
        select: {
          name: true,
          email: true,
          rates: { where: { workspaceId: actor.workspaceId }, orderBy: { effectiveFrom: "desc" }, take: 1 },
        },
      },
    },
  });
  return csv(
    ["name", "email", "role", "active", "billable_rate", "cost_rate"],
    members.map((member) => [
      member.user.name,
      member.user.email,
      member.role,
      member.active,
      member.user.rates[0]?.billableMinor,
      member.user.rates[0]?.costMinor,
    ]),
  );
}
