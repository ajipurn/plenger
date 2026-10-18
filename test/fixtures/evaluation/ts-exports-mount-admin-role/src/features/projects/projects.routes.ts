import { Router } from "express";
import { session } from "../../auth/context.ts";
import { requireRole } from "../../http/middleware/require-role.ts";
import { body } from "../../http/middleware/validate.ts";
import { projectCreate, projectUpdate } from "./projects.schema.ts";
import { createProject, getProject, listProjects, updateProject } from "./projects.service.ts";

export const projectsRouter = Router();

projectsRouter.get("/", async (request, response) => {
  const clientId = typeof request.query.client === "string" ? request.query.client : undefined;
  response.json(await listProjects(session(response), clientId));
});

projectsRouter.get("/:id", async (request, response) => {
  response.json(await getProject(session(response), request.params.id));
});

projectsRouter.post("/", requireRole("manager"), body(projectCreate), async (request, response) => {
  response.status(201).json(await createProject(session(response), request.body));
});

projectsRouter.patch("/:id", requireRole("manager"), body(projectUpdate), async (request, response) => {
  response.json(await updateProject(session(response), request.params.id, request.body));
});
