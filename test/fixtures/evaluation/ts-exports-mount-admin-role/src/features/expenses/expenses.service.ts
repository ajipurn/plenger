import type { Session } from "../../auth/session.ts";
import { atLeast } from "../../auth/roles.ts";
import { prisma } from "../../db.ts";
import { HttpError, notFound } from "../../http/middleware/errors.ts";
import type { ExpenseCreate } from "./expenses.schema.ts";

export function listExpenses(actor: Session, projectId?: string) {
  // Managers see the workspace's expenses; members see their own.
  const own = atLeast(actor.role, "manager") ? {} : { userId: actor.userId };
  return prisma.expense.findMany({
    where: { workspaceId: actor.workspaceId, ...own, ...(projectId ? { projectId } : {}) },
    orderBy: { date: "desc" },
  });
}

export async function createExpense(actor: Session, data: ExpenseCreate) {
  const project = await prisma.project.findFirst({
    where: { id: data.projectId, workspaceId: actor.workspaceId, archived: false },
  });
  if (!project) throw new HttpError(422, "unknown project");
  return prisma.expense.create({
    data: {
      ...data,
      date: new Date(data.date),
      userId: actor.userId,
      workspaceId: actor.workspaceId,
    },
  });
}

export async function deleteExpense(actor: Session, expenseId: string) {
  const { count } = await prisma.expense.deleteMany({
    where: { id: expenseId, workspaceId: actor.workspaceId, userId: actor.userId, reimbursed: false },
  });
  if (!count) throw notFound("expense");
}
