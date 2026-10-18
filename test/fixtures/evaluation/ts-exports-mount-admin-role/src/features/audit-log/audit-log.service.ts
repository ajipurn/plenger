import type { Session } from "../../auth/session.ts";
import { prisma } from "../../db.ts";
import { type PageQuery, page, window } from "../../lib/pagination.ts";

export async function audit(
  actor: Session,
  action: string,
  target: { type: string; id: string },
  details: Record<string, unknown> = {},
) {
  await prisma.auditEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action,
      targetType: target.type,
      targetId: target.id,
      details,
    },
  });
}

export async function listAuditEvents(actor: Session, query: PageQuery & { action?: string }) {
  const rows = await prisma.auditEvent.findMany({
    where: { workspaceId: actor.workspaceId, ...(query.action ? { action: query.action } : {}) },
    ...window(query),
  });
  return page(rows, query.limit);
}
