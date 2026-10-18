import type { Session } from "../../auth/session.ts";
import { prisma } from "../../db.ts";
import { HttpError, notFound } from "../../http/middleware/errors.ts";
import { audit } from "../audit-log/audit-log.service.ts";
import type { RoleChange } from "./members.schema.ts";

export function listMembers(actor: Session) {
  return prisma.membership.findMany({
    where: { workspaceId: actor.workspaceId, active: true },
    select: { id: true, role: true, user: { select: { id: true, name: true, avatarUrl: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export async function changeRole(actor: Session, membershipId: string, change: RoleChange) {
  const membership = await prisma.membership.findFirst({
    where: { id: membershipId, workspaceId: actor.workspaceId, active: true },
  });
  if (!membership) throw notFound("member");
  if (membership.role === "owner") throw new HttpError(409, "the owner's role cannot change");
  if (membership.userId === actor.userId) throw new HttpError(409, "you cannot change your own role");
  const updated = await prisma.membership.update({
    where: { id: membership.id },
    data: { role: change.role },
  });
  await audit(actor, "member.role_changed", { type: "membership", id: membership.id }, {
    from: membership.role,
    to: change.role,
  });
  return updated;
}

export async function removeMember(actor: Session, membershipId: string) {
  const membership = await prisma.membership.findFirst({
    where: { id: membershipId, workspaceId: actor.workspaceId, active: true },
  });
  if (!membership) throw notFound("member");
  if (membership.role === "owner" || membership.userId === actor.userId)
    throw new HttpError(409, "this member cannot be removed");
  await prisma.membership.update({ where: { id: membership.id }, data: { active: false } });
  await audit(actor, "member.removed", { type: "membership", id: membership.id });
}
