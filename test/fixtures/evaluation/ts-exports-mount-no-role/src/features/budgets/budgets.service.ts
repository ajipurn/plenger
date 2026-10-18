import type { Session } from "../../auth/session.ts";
import { prisma } from "../../db.ts";
import { HttpError } from "../../http/middleware/errors.ts";
import type { BudgetSet } from "./budgets.schema.ts";

export async function budgetStatus(actor: Session) {
  const budgets = await prisma.budget.findMany({
    where: { workspaceId: actor.workspaceId },
    include: { project: { select: { id: true, name: true } } },
  });
  const spent = await prisma.timeEntry.groupBy({
    by: ["projectId"],
    where: { workspaceId: actor.workspaceId, projectId: { in: budgets.map((item) => item.projectId) } },
    _sum: { minutes: true },
  });
  const minutes = new Map(spent.map((row) => [row.projectId, row._sum.minutes ?? 0]));
  return budgets.map((budget) => {
    const used = minutes.get(budget.projectId) ?? 0;
    const ratio = budget.minutes ? used / budget.minutes : null;
    return { ...budget, usedMinutes: used, ratio, alert: ratio !== null && ratio >= budget.alertAt };
  });
}

export async function setBudget(actor: Session, data: BudgetSet) {
  if (!data.minutes && !data.amountMinor) throw new HttpError(422, "set minutes or an amount");
  const project = await prisma.project.findFirst({
    where: { id: data.projectId, workspaceId: actor.workspaceId },
  });
  if (!project) throw new HttpError(422, "unknown project");
  return prisma.budget.upsert({
    where: { projectId: project.id },
    create: { ...data, workspaceId: actor.workspaceId },
    update: { minutes: data.minutes, amountMinor: data.amountMinor, alertAt: data.alertAt },
  });
}
