import { Router } from "express";
import { session } from "../../auth/context.ts";
import { requireRole } from "../../http/middleware/require-role.ts";
import { body } from "../../http/middleware/validate.ts";
import { review, weekParam } from "./timesheets.schema.ts";
import { pendingTimesheets, reviewTimesheet, submitWeek } from "./timesheets.service.ts";

export const timesheetsRouter = Router();

timesheetsRouter.post("/submit", body(weekParam), async (request, response) => {
  response.json(await submitWeek(session(response), request.body.week));
});

timesheetsRouter.get("/pending", requireRole("manager"), async (_request, response) => {
  response.json(await pendingTimesheets(session(response)));
});

timesheetsRouter.post("/:id/review", requireRole("manager"), body(review), async (request, response) => {
  response.json(await reviewTimesheet(session(response), request.params.id, request.body));
});
