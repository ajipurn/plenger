import type { Session } from "../../auth/session.ts";
import { prisma } from "../../db.ts";
import type { Preferences } from "./notifications.schema.ts";

export function unread(actor: Session) {
  return prisma.notification.findMany({
    where: { workspaceId: actor.workspaceId, userId: actor.userId, readAt: null },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export async function markAsRead(actor: Session, ids: string[]) {
  const { count } = await prisma.notification.updateMany({
    where: { id: { in: ids }, workspaceId: actor.workspaceId, userId: actor.userId, readAt: null },
    data: { readAt: new Date() },
  });
  return { marked: count };
}

export function savePreferences(actor: Session, change: Preferences) {
  return prisma.notificationPreference.upsert({
    where: { workspaceId_userId: { workspaceId: actor.workspaceId, userId: actor.userId } },
    create: { ...change, workspaceId: actor.workspaceId, userId: actor.userId },
    update: change,
  });
}
