import { Router } from "express";
import { session } from "../../auth/context.ts";
import { query } from "../../http/middleware/validate.ts";
import { reportRange } from "./reports.schema.ts";
import { profitability, utilization } from "./reports.service.ts";

export const reportsRouter = Router();

reportsRouter.get("/profitability", async (request, response) => {
  response.json(await profitability(session(response), query(reportRange, request)));
});

reportsRouter.get("/utilization", async (request, response) => {
  response.json(await utilization(session(response), query(reportRange, request)));
});
