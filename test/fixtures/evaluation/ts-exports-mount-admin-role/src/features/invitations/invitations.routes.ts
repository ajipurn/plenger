import { Router } from "express";
import { session } from "../../auth/context.ts";
import { body } from "../../http/middleware/validate.ts";
import { invitationCreate } from "./invitations.schema.ts";
import { invite, listInvitations, revokeInvitation } from "./invitations.service.ts";

export const invitationsRouter = Router();

invitationsRouter.get("/", async (_request, response) => {
  response.json(await listInvitations(session(response)));
});

invitationsRouter.post("/", body(invitationCreate), async (request, response) => {
  response.status(201).json(await invite(session(response), request.body));
});

invitationsRouter.delete("/:id", async (request, response) => {
  await revokeInvitation(session(response), request.params.id);
  response.status(204).end();
});
