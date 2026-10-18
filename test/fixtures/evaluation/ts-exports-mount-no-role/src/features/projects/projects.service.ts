import type { Session } from "../../auth/session.ts";
import { prisma } from "../../db.ts";
import { HttpError, notFound } from "../../http/middleware/errors.ts";
import type { ProjectCreate, ProjectUpdate } from "./projects.schema.ts";

export function listProjects(actor: Session, clientId?: string) {
  return prisma.project.findMany({
    where: { workspaceId: actor.workspaceId, archived: false, ...(clientId ? { clientId } : {}) },
    include: { client: { select: { id: true, name: true } } },
    orderBy: { name: "asc" },
  });
}

export async function getProject(actor: Session, projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspaceId: actor.workspaceId },
    include: { client: { select: { id: true, name: true } } },
  });
  if (!project) throw notFound("project");
  return project;
}

export async function createProject(actor: Session, data: ProjectCreate) {
  const client = await prisma.client.findFirst({
    where: { id: data.clientId, workspaceId: actor.workspaceId, archived: false },
  });
  if (!client) throw new HttpError(422, "unknown client");
  return prisma.project.create({ data: { ...data, workspaceId: actor.workspaceId } });
}

export async function updateProject(actor: Session, projectId: string, change: ProjectUpdate) {
  const project = await getProject(actor, projectId);
  return prisma.project.update({ where: { id: project.id }, data: change });
}
