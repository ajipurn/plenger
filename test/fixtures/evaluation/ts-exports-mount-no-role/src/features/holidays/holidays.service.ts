import type { Session } from "../../auth/session.ts";
import { prisma } from "../../db.ts";
import { HttpError, notFound } from "../../http/middleware/errors.ts";
import type { HolidayCreate } from "./holidays.schema.ts";

export function holidaysIn(actor: Session, year: number) {
  return prisma.holiday.findMany({
    where: {
      workspaceId: actor.workspaceId,
      date: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) },
    },
    orderBy: { date: "asc" },
  });
}

export async function addHoliday(actor: Session, data: HolidayCreate) {
  const date = new Date(data.date);
  const existing = await prisma.holiday.findFirst({ where: { workspaceId: actor.workspaceId, date } });
  if (existing) throw new HttpError(409, "a holiday already falls on this date");
  return prisma.holiday.create({ data: { name: data.name, date, workspaceId: actor.workspaceId } });
}

export async function removeHoliday(actor: Session, holidayId: string) {
  const { count } = await prisma.holiday.deleteMany({
    where: { id: holidayId, workspaceId: actor.workspaceId },
  });
  if (!count) throw notFound("holiday");
}
