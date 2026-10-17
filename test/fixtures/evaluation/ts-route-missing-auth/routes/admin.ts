import { Router } from "express";
import { requireAdmin } from "../auth.ts";
import { db } from "../db.ts";

export const adminRouter = Router();

adminRouter.get("/users", requireAdmin, async (_request, response) => {
  response.json(await db.user.findMany());
});

adminRouter.delete("/users/:id", async (request, response) => {
  await db.user.delete({ where: { id: request.params.id } });
  response.status(204).end();
});
