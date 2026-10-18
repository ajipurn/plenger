import type { Session } from "../../auth/session.ts";
import { prisma } from "../../db.ts";
import { HttpError, notFound } from "../../http/middleware/errors.ts";
import type { TagCreate } from "./tags.schema.ts";

export function listTags(actor: Session) {
  return prisma.tag.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { name: "asc" } });
}

export async function createTag(actor: Session, data: TagCreate) {
  const existing = await prisma.tag.findFirst({
    where: { workspaceId: actor.workspaceId, name: data.name },
  });
  if (existing) throw new HttpError(409, "a tag with this name exists");
  return prisma.tag.create({ data: { ...data, workspaceId: actor.workspaceId } });
}

export async function setTaskTags(actor: Session, taskId: string, tagIds: string[]) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, project: { workspaceId: actor.workspaceId } },
  });
  if (!task) throw notFound("task");
  const tags = await prisma.tag.findMany({
    where: { id: { in: tagIds }, workspaceId: actor.workspaceId },
    select: { id: true },
  });
  if (tags.length !== new Set(tagIds).size) throw new HttpError(422, "unknown tag");
  return prisma.task.update({
    where: { id: task.id },
    data: { tags: { set: tags } },
    include: { tags: true },
  });
}
