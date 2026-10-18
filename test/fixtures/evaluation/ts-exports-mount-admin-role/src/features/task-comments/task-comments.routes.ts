import { Router } from "express";
import { session } from "../../auth/context.ts";
import { body } from "../../http/middleware/validate.ts";
import { commentCreate, commentEdit } from "./task-comments.schema.ts";
import { addComment, deleteComment, editComment, listComments } from "./task-comments.service.ts";

export const taskCommentsRouter = Router();

taskCommentsRouter.get("/tasks/:taskId", async (request, response) => {
  response.json(await listComments(session(response), request.params.taskId));
});

taskCommentsRouter.post("/tasks/:taskId", body(commentCreate), async (request, response) => {
  response.status(201).json(await addComment(session(response), request.params.taskId, request.body));
});

taskCommentsRouter.patch("/:id", body(commentEdit), async (request, response) => {
  await editComment(session(response), request.params.id, request.body);
  response.status(204).end();
});

taskCommentsRouter.delete("/:id", async (request, response) => {
  await deleteComment(session(response), request.params.id);
  response.status(204).end();
});
