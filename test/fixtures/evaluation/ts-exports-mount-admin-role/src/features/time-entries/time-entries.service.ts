import type { Session } from "../../auth/session.ts";
import { prisma } from "../../db.ts";
import { HttpError, notFound } from "../../http/middleware/errors.ts";
import type { EntryCreate, EntryUpdate } from "./time-entries.schema.ts";

/** Members edit their own entries until the week's timesheet is submitted. */
async function editableEntry(actor: Session, entryId: string) {
  const entry = await prisma.timeEntry.findFirst({
    where: { id: entryId, userId: actor.userId, workspaceId: actor.workspaceId },
    include: { timesheet: { select: { status: true } } },
  });
  if (!entry) throw notFound("time entry");
  if (entry.timesheet && entry.timesheet.status !== "draft")
    throw new HttpError(409, "the timesheet for this week is already submitted");
  return entry;
}

export function listOwnEntries(actor: Session, from: string, to: string) {
  return prisma.timeEntry.findMany({
    where: {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      date: { gte: new Date(from), lte: new Date(to) },
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });
}

export async function createEntry(actor: Session, data: EntryCreate) {
  const project = await prisma.project.findFirst({
    where: { id: data.projectId, workspaceId: actor.workspaceId, archived: false },
  });
  if (!project) throw new HttpError(422, "unknown project");
  return prisma.timeEntry.create({
    data: {
      ...data,
      date: new Date(data.date),
      billable: project.billable && data.billable,
      userId: actor.userId,
      workspaceId: actor.workspaceId,
    },
  });
}

export async function updateEntry(actor: Session, entryId: string, change: EntryUpdate) {
  const entry = await editableEntry(actor, entryId);
  return prisma.timeEntry.update({
    where: { id: entry.id },
    data: { ...change, ...(change.date ? { date: new Date(change.date) } : {}) },
  });
}

export async function deleteEntry(actor: Session, entryId: string) {
  const entry = await editableEntry(actor, entryId);
  await prisma.timeEntry.delete({ where: { id: entry.id } });
}
