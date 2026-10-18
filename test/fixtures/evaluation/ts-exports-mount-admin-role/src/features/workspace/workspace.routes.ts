import { Router } from "express";
import { session } from "../../auth/context.ts";
import { requireRole } from "../../http/middleware/require-role.ts";
import { body } from "../../http/middleware/validate.ts";
import { workspaceUpdate } from "./workspace.schema.ts";
import { currentWorkspace, updateWorkspace } from "./workspace.service.ts";

export const workspaceRouter = Router();

workspaceRouter.get("/", async (_request, response) => {
  response.json(await currentWorkspace(session(response)));
});

workspaceRouter.patch("/", requireRole("admin"), body(workspaceUpdate), async (request, response) => {
  response.json(await updateWorkspace(session(response), request.body));
});
