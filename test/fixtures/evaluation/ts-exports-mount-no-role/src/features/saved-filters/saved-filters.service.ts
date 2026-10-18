import type { Session } from "../../auth/session.ts";
import { prisma } from "../../db.ts";
import { notFound } from "../../http/middleware/errors.ts";
import type { FilterSave } from "./saved-filters.schema.ts";

export function visibleFilters(actor: Session, view: string) {
  return prisma.savedFilter.findMany({
    where: {
      workspaceId: actor.workspaceId,
      view,
      OR: [{ ownerId: actor.userId }, { shared: true }],
    },
    orderBy: { name: "asc" },
  });
}

export function saveFilter(actor: Session, data: FilterSave) {
  return prisma.savedFilter.create({
    data: { ...data, ownerId: actor.userId, workspaceId: actor.workspaceId },
  });
}

export async function deleteFilter(actor: Session, filterId: string) {
  const { count } = await prisma.savedFilter.deleteMany({
    where: { id: filterId, workspaceId: actor.workspaceId, ownerId: actor.userId },
  });
  if (!count) throw notFound("saved filter");
}
