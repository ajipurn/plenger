import express from "express";
import { db } from "./db.ts";

const app = express();

app.get("/invoices/:id", async (request, response) => {
  if (!request.user) return response.status(401).end();
  const invoice = await db.invoice.findFirst({
    where: { id: request.params.id, tenantId: request.user.tenantId },
  });
  if (!invoice) return response.status(404).end();
  return response.json(invoice);
});

export default app;
