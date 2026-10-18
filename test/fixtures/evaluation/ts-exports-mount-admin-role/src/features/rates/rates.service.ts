import type { Session } from "../../auth/session.ts";
import { prisma } from "../../db.ts";
import { HttpError } from "../../http/middleware/errors.ts";
import { audit } from "../audit-log/audit-log.service.ts";
import type { RateSet } from "./rates.schema.ts";

export function listRates(actor: Session) {
  return prisma.rate.findMany({
    where: { workspaceId: actor.workspaceId },
    include: { user: { select: { id: true, name: true } }, project: { select: { id: true, name: true } } },
    orderBy: [{ userId: "asc" }, { effectiveFrom: "desc" }],
  });
}

export async function setRate(actor: Session, data: RateSet) {
  const member = await prisma.membership.findFirst({
    where: { userId: data.userId, workspaceId: actor.workspaceId, active: true },
  });
  if (!member) throw new HttpError(422, "not a member of this workspace");
  if (data.projectId) {
    const project = await prisma.project.findFirst({
      where: { id: data.projectId, workspaceId: actor.workspaceId },
    });
    if (!project) throw new HttpError(422, "unknown project");
  }
  const rate = await prisma.rate.create({
    data: { ...data, effectiveFrom: new Date(data.effectiveFrom), workspaceId: actor.workspaceId },
  });
  await audit(actor, "rate.set", { type: "rate", id: rate.id }, { userId: data.userId });
  return rate;
}
