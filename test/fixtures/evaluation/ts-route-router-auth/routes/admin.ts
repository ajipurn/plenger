import { Router } from "express";
import { db } from "../db.ts";

export const adminRouter = Router();

adminRouter.get("/users", async (_request, response) => {
  response.json(await db.user.findMany());
});

adminRouter.delete("/users/:id", async (request, response) => {
  await db.user.delete({ where: { id: request.params.id } });
  response.status(204).end();
});
