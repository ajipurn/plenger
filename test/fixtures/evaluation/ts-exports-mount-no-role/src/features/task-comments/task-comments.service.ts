import type { Session } from "../../auth/session.ts";
import { prisma } from "../../db.ts";
import { notFound } from "../../http/middleware/errors.ts";
import type { CommentCreate } from "./task-comments.schema.ts";

async function taskInWorkspace(actor: Session, taskId: string) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, project: { workspaceId: actor.workspaceId } },
    select: { id: true, assigneeId: true },
  });
  if (!task) throw notFound("task");
  return task;
}

export async function listComments(actor: Session, taskId: string) {
  const task = await taskInWorkspace(actor, taskId);
  return prisma.taskComment.findMany({
    where: { taskId: task.id, deletedAt: null },
    include: { author: { select: { id: true, name: true, avatarUrl: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export async function addComment(actor: Session, taskId: string, data: CommentCreate) {
  const task = await taskInWorkspace(actor, taskId);
  const comment = await prisma.taskComment.create({
    data: { taskId: task.id, authorId: actor.userId, body: data.body },
  });
  if (task.assigneeId && task.assigneeId !== actor.userId)
    await prisma.notification.create({
      data: {
        workspaceId: actor.workspaceId,
        userId: task.assigneeId,
        kind: "task.comment",
        subjectId: comment.id,
      },
    });
  return comment;
}

export async function editComment(actor: Session, commentId: string, data: CommentCreate) {
  const { count } = await prisma.taskComment.updateMany({
    where: {
      id: commentId,
      authorId: actor.userId,
      deletedAt: null,
      task: { project: { workspaceId: actor.workspaceId } },
    },
    data: { body: data.body, editedAt: new Date() },
  });
  if (!count) throw notFound("comment");
}

export async function deleteComment(actor: Session, commentId: string) {
  const { count } = await prisma.taskComment.updateMany({
    where: {
      id: commentId,
      authorId: actor.userId,
      deletedAt: null,
      task: { project: { workspaceId: actor.workspaceId } },
    },
    data: { deletedAt: new Date() },
  });
  if (!count) throw notFound("comment");
}
