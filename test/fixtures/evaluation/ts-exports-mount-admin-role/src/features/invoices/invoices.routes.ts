import { Router } from "express";
import { session } from "../../auth/context.ts";
import { body } from "../../http/middleware/validate.ts";
import { invoiceDraft } from "./invoices.schema.ts";
import { draftInvoice, issueInvoice, listInvoices } from "./invoices.service.ts";

export const invoicesRouter = Router();

invoicesRouter.get("/", async (request, response) => {
  const clientId = typeof request.query.client === "string" ? request.query.client : undefined;
  response.json(await listInvoices(session(response), clientId));
});

invoicesRouter.post("/", body(invoiceDraft), async (request, response) => {
  response.status(201).json(await draftInvoice(session(response), request.body));
});

invoicesRouter.post("/:id/issue", async (request, response) => {
  await issueInvoice(session(response), request.params.id);
  response.status(204).end();
});
