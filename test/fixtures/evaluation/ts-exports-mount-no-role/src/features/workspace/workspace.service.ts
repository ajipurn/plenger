import type { Session } from "../../auth/session.ts";
import { prisma } from "../../db.ts";
import { audit } from "../audit-log/audit-log.service.ts";
import type { WorkspaceUpdate } from "./workspace.schema.ts";

export function currentWorkspace(actor: Session) {
  return prisma.workspace.findUniqueOrThrow({
    where: { id: actor.workspaceId },
    select: { id: true, name: true, currency: true, weekStartsOn: true, timesheetApproval: true },
  });
}

export async function updateWorkspace(actor: Session, change: WorkspaceUpdate) {
  const workspace = await prisma.workspace.update({ where: { id: actor.workspaceId }, data: change });
  await audit(actor, "workspace.updated", { type: "workspace", id: workspace.id }, change);
  return workspace;
}
