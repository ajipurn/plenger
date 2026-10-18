import { Router } from "express";
import { session } from "../../auth/context.ts";
import { query } from "../../http/middleware/validate.ts";
import { auditQuery } from "./audit-log.schema.ts";
import { listAuditEvents } from "./audit-log.service.ts";

export const auditLogRouter = Router();

auditLogRouter.get("/", async (request, response) => {
  response.json(await listAuditEvents(session(response), query(auditQuery, request)));
});
