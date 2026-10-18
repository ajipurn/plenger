import { randomBytes } from "node:crypto";
import type { Session } from "../../auth/session.ts";
import { prisma } from "../../db.ts";
import { HttpError, notFound } from "../../http/middleware/errors.ts";
import { addDays } from "../../lib/dates.ts";
import { audit } from "../audit-log/audit-log.service.ts";
import type { InvitationCreate } from "./invitations.schema.ts";

export function listInvitations(actor: Session) {
  return prisma.invitation.findMany({
    where: { workspaceId: actor.workspaceId, acceptedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, email: true, role: true, expiresAt: true },
  });
}

export async function invite(actor: Session, data: InvitationCreate) {
  const existing = await prisma.membership.findFirst({
    where: { workspaceId: actor.workspaceId, active: true, user: { email: data.email } },
  });
  if (existing) throw new HttpError(409, "already a member");
  const invitation = await prisma.invitation.create({
    data: {
      workspaceId: actor.workspaceId,
      invitedById: actor.userId,
      email: data.email,
      role: data.role,
      token: randomBytes(32).toString("base64url"),
      expiresAt: addDays(new Date(), 7),
    },
    select: { id: true, email: true, role: true, expiresAt: true },
  });
  await audit(actor, "invitation.created", { type: "invitation", id: invitation.id }, {
    role: data.role,
  });
  return invitation;
}

export async function revokeInvitation(actor: Session, invitationId: string) {
  const { count } = await prisma.invitation.deleteMany({
    where: { id: invitationId, workspaceId: actor.workspaceId, acceptedAt: null },
  });
  if (!count) throw notFound("invitation");
  await audit(actor, "invitation.revoked", { type: "invitation", id: invitationId });
}
