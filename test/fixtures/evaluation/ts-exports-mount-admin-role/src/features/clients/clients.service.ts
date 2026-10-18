import type { Session } from "../../auth/session.ts";
import { config } from "../../config.ts";
import { prisma } from "../../db.ts";
import { notFound } from "../../http/middleware/errors.ts";
import type { ClientCreate, ClientUpdate } from "./clients.schema.ts";

export function listClients(actor: Session, includeArchived: boolean) {
  return prisma.client.findMany({
    where: { workspaceId: actor.workspaceId, ...(includeArchived ? {} : { archived: false }) },
    orderBy: { name: "asc" },
  });
}

export function createClient(actor: Session, data: ClientCreate) {
  return prisma.client.create({
    data: { ...data, currency: data.currency ?? config.defaultCurrency, workspaceId: actor.workspaceId },
  });
}

export async function updateClient(actor: Session, clientId: string, change: ClientUpdate) {
  const { count } = await prisma.client.updateMany({
    where: { id: clientId, workspaceId: actor.workspaceId },
    data: change,
  });
  if (!count) throw notFound("client");
  return prisma.client.findUniqueOrThrow({ where: { id: clientId } });
}
