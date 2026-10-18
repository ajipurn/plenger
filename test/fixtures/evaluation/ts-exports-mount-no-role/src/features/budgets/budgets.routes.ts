import { Router } from "express";
import { session } from "../../auth/context.ts";
import { body } from "../../http/middleware/validate.ts";
import { budgetSet } from "./budgets.schema.ts";
import { budgetStatus, setBudget } from "./budgets.service.ts";

export const budgetsRouter = Router();

budgetsRouter.get("/", async (_request, response) => {
  response.json(await budgetStatus(session(response)));
});

budgetsRouter.put("/", body(budgetSet), async (request, response) => {
  response.json(await setBudget(session(response), request.body));
});
