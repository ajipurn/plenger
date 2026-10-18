import { Router } from "express";
import { session } from "../../auth/context.ts";
import { requireRole } from "../../http/middleware/require-role.ts";
import { body } from "../../http/middleware/validate.ts";
import { clientCreate, clientUpdate } from "./clients.schema.ts";
import { createClient, listClients, updateClient } from "./clients.service.ts";

export const clientsRouter = Router();

clientsRouter.get("/", async (request, response) => {
  response.json(await listClients(session(response), request.query.archived === "true"));
});

clientsRouter.post("/", requireRole("manager"), body(clientCreate), async (request, response) => {
  response.status(201).json(await createClient(session(response), request.body));
});

clientsRouter.patch("/:id", requireRole("manager"), body(clientUpdate), async (request, response) => {
  response.json(await updateClient(session(response), request.params.id, request.body));
});
