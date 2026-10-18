import { Router } from "express";
import { session } from "../../auth/context.ts";
import { body } from "../../http/middleware/validate.ts";
import { expenseCreate } from "./expenses.schema.ts";
import { createExpense, deleteExpense, listExpenses } from "./expenses.service.ts";

export const expensesRouter = Router();

expensesRouter.get("/", async (request, response) => {
  const projectId = typeof request.query.project === "string" ? request.query.project : undefined;
  response.json(await listExpenses(session(response), projectId));
});

expensesRouter.post("/", body(expenseCreate), async (request, response) => {
  response.status(201).json(await createExpense(session(response), request.body));
});

expensesRouter.delete("/:id", async (request, response) => {
  await deleteExpense(session(response), request.params.id);
  response.status(204).end();
});
