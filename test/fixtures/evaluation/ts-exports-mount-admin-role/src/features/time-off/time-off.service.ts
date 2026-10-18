import type { Session } from "../../auth/session.ts";
import { prisma } from "../../db.ts";
import { HttpError, notFound } from "../../http/middleware/errors.ts";
import { audit } from "../audit-log/audit-log.service.ts";
import type { TimeOffRequest } from "./time-off.schema.ts";

export function ownRequests(actor: Session) {
  return prisma.timeOffRequest.findMany({
    where: { workspaceId: actor.workspaceId, userId: actor.userId },
    orderBy: { from: "desc" },
  });
}

export async function requestTimeOff(actor: Session, data: TimeOffRequest) {
  const overlapping = await prisma.timeOffRequest.findFirst({
    where: {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      status: { not: "rejected" },
      from: { lte: new Date(data.to) },
      to: { gte: new Date(data.from) },
    },
  });
  if (overlapping) throw new HttpError(409, "overlaps an existing request");
  return prisma.timeOffRequest.create({
    data: {
      ...data,
      from: new Date(data.from),
      to: new Date(data.to),
      status: "pending",
      userId: actor.userId,
      workspaceId: actor.workspaceId,
    },
  });
}

export function pendingRequests(actor: Session) {
  return prisma.timeOffRequest.findMany({
    where: { workspaceId: actor.workspaceId, status: "pending" },
    include: { user: { select: { id: true, name: true } } },
    orderBy: { from: "asc" },
  });
}

export async function decide(actor: Session, requestId: string, approve: boolean) {
  const request = await prisma.timeOffRequest.findFirst({
    where: { id: requestId, workspaceId: actor.workspaceId, status: "pending" },
  });
  if (!request) throw notFound("time-off request");
  if (request.userId === actor.userId) throw new HttpError(409, "you cannot decide your own request");
  const status = approve ? "approved" : "rejected";
  const updated = await prisma.timeOffRequest.update({
    where: { id: request.id },
    data: { status, decidedById: actor.userId, decidedAt: new Date() },
  });
  await audit(actor, `time_off.${status}`, { type: "time_off_request", id: request.id });
  return updated;
}
