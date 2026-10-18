import type { Session } from "../../auth/session.ts";
import { prisma } from "../../db.ts";
import { HttpError, notFound } from "../../http/middleware/errors.ts";
import { addDays, startOfWeek } from "../../lib/dates.ts";
import { audit } from "../audit-log/audit-log.service.ts";
import type { Review } from "./timesheets.schema.ts";

export async function submitWeek(actor: Session, week: string) {
  const start = startOfWeek(new Date(week));
  const entries = await prisma.timeEntry.findMany({
    where: {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      date: { gte: start, lt: addDays(start, 7) },
    },
    select: { id: true, minutes: true },
  });
  if (!entries.length) throw new HttpError(422, "no time recorded this week");
  return prisma.timesheet.upsert({
    where: {
      workspaceId_userId_weekStart: {
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        weekStart: start,
      },
    },
    create: {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      weekStart: start,
      status: "submitted",
      minutes: entries.reduce((sum, entry) => sum + entry.minutes, 0),
      entries: { connect: entries.map((entry) => ({ id: entry.id })) },
    },
    update: { status: "submitted", entries: { set: entries.map((entry) => ({ id: entry.id })) } },
  });
}

export function pendingTimesheets(actor: Session) {
  return prisma.timesheet.findMany({
    where: { workspaceId: actor.workspaceId, status: "submitted" },
    include: { user: { select: { id: true, name: true } } },
    orderBy: { weekStart: "asc" },
  });
}

export async function reviewTimesheet(actor: Session, timesheetId: string, decision: Review) {
  const timesheet = await prisma.timesheet.findFirst({
    where: { id: timesheetId, workspaceId: actor.workspaceId, status: "submitted" },
  });
  if (!timesheet) throw notFound("timesheet");
  if (timesheet.userId === actor.userId) throw new HttpError(409, "you cannot review your own timesheet");
  const updated = await prisma.timesheet.update({
    where: { id: timesheet.id },
    data: {
      status: decision.decision === "approved" ? "approved" : "draft",
      reviewerId: actor.userId,
      reviewComment: decision.comment,
    },
  });
  await audit(actor, `timesheet.${decision.decision}`, { type: "timesheet", id: timesheet.id });
  return updated;
}
