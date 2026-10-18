import { Router } from "express";
import { z } from "zod";
import { session } from "../../auth/context.ts";
import { body, query } from "../../http/middleware/validate.ts";
import { taskCreate, taskUpdate } from "./tasks.schema.ts";
import { createTask, listTasks, updateTask } from "./tasks.service.ts";

export const tasksRouter = Router();

tasksRouter.get("/", async (request, response) => {
  const { project } = query(z.object({ project: z.string().uuid() }), request);
  response.json(await listTasks(session(response), project));
});

tasksRouter.post("/", body(taskCreate), async (request, response) => {
  response.status(201).json(await createTask(session(response), request.body));
});

tasksRouter.patch("/:id", body(taskUpdate), async (request, response) => {
  response.json(await updateTask(session(response), request.params.id, request.body));
});
