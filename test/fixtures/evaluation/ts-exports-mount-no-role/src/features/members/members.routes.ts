import { Router } from "express";
import { session } from "../../auth/context.ts";
import { requireRole } from "../../http/middleware/require-role.ts";
import { body } from "../../http/middleware/validate.ts";
import { roleChange } from "./members.schema.ts";
import { changeRole, listMembers, removeMember } from "./members.service.ts";

export const membersRouter = Router();

membersRouter.get("/", async (_request, response) => {
  response.json(await listMembers(session(response)));
});

membersRouter.put("/:id/role", requireRole("admin"), body(roleChange), async (request, response) => {
  response.json(await changeRole(session(response), request.params.id, request.body));
});

membersRouter.delete("/:id", requireRole("admin"), async (request, response) => {
  await removeMember(session(response), request.params.id);
  response.status(204).end();
});
