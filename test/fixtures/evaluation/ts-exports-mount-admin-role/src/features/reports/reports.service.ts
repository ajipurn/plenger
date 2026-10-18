import type { Session } from "../../auth/session.ts";
import { prisma } from "../../db.ts";
import { amount } from "../../lib/money.ts";
import type { ReportRange } from "./reports.schema.ts";

export async function profitability(actor: Session, range: ReportRange) {
  const entries = await prisma.timeEntry.findMany({
    where: {
      workspaceId: actor.workspaceId,
      date: { gte: new Date(range.from), lte: new Date(range.to) },
      ...(range.clientId ? { project: { clientId: range.clientId } } : {}),
    },
    select: { minutes: true, billable: true, projectId: true, rate: true },
  });
  const byProject = new Map<string, { minutes: number; revenueMinor: number; costMinor: number }>();
  for (const entry of entries) {
    const row = byProject.get(entry.projectId) ?? { minutes: 0, revenueMinor: 0, costMinor: 0 };
    row.minutes += entry.minutes;
    if (entry.rate) {
      if (entry.billable) row.revenueMinor += amount(entry.minutes, entry.rate.billableMinor);
      row.costMinor += amount(entry.minutes, entry.rate.costMinor);
    }
    byProject.set(entry.projectId, row);
  }
  return [...byProject].map(([projectId, row]) => ({
    projectId,
    ...row,
    marginMinor: row.revenueMinor - row.costMinor,
  }));
}

export async function utilization(actor: Session, range: ReportRange) {
  const rows = await prisma.timeEntry.groupBy({
    by: ["userId", "billable"],
    where: { workspaceId: actor.workspaceId, date: { gte: new Date(range.from), lte: new Date(range.to) } },
    _sum: { minutes: true },
  });
  const users = new Map<string, { billable: number; total: number }>();
  for (const row of rows) {
    const user = users.get(row.userId) ?? { billable: 0, total: 0 };
    const minutes = row._sum.minutes ?? 0;
    user.total += minutes;
    if (row.billable) user.billable += minutes;
    users.set(row.userId, user);
  }
  return [...users].map(([userId, user]) => ({
    userId,
    ...user,
    ratio: user.total ? user.billable / user.total : 0,
  }));
}
