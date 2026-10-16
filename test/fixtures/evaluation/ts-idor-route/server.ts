import express from "express";
import { db } from "./db.ts";

const app = express();

app.get("/invoices/:id", async (request, response) => {
  if (!request.user) return response.status(401).end();
  const invoice = await db.invoice.findUnique({ where: { id: request.params.id } });
  return response.json(invoice);
});

export default app;
