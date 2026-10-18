import { Router } from "express";
import { session } from "../../auth/context.ts";
import { body } from "../../http/middleware/validate.ts";
import { tagCreate, taskTags } from "./tags.schema.ts";
import { createTag, listTags, setTaskTags } from "./tags.service.ts";

export const tagsRouter = Router();

tagsRouter.get("/", async (_request, response) => {
  response.json(await listTags(session(response)));
});

tagsRouter.post("/", body(tagCreate), async (request, response) => {
  response.status(201).json(await createTag(session(response), request.body));
});

tagsRouter.put("/tasks/:taskId", body(taskTags), async (request, response) => {
  response.json(await setTaskTags(session(response), request.params.taskId, request.body.tagIds));
});
