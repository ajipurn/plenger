import type { Session } from "../../auth/session.ts";
import { prisma } from "../../db.ts";
import { HttpError, notFound } from "../../http/middleware/errors.ts";
import type { TaskCreate, TaskUpdate } from "./tasks.schema.ts";

async function assertMember(actor: Session, userId: string | undefined) {
  if (!userId) return;
  const member = await prisma.membership.findFirst({
    where: { userId, workspaceId: actor.workspaceId, active: true },
  });
  if (!member) throw new HttpError(422, "the assignee is not a member");
}

export function listTasks(actor: Session, projectId: string) {
  return prisma.task.findMany({
    where: { projectId, project: { workspaceId: actor.workspaceId } },
    orderBy: [{ done: "asc" }, { createdAt: "asc" }],
  });
}

export async function createTask(actor: Session, data: TaskCreate) {
  const project = await prisma.project.findFirst({
    where: { id: data.projectId, workspaceId: actor.workspaceId, archived: false },
  });
  if (!project) throw new HttpError(422, "unknown project");
  await assertMember(actor, data.assigneeId);
  return prisma.task.create({ data });
}

export async function updateTask(actor: Session, taskId: string, change: TaskUpdate) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, project: { workspaceId: actor.workspaceId } },
  });
  if (!task) throw notFound("task");
  await assertMember(actor, change.assigneeId);
  return prisma.task.update({ where: { id: task.id }, data: change });
}
