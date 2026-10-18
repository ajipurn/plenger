import { Router } from "express";
import { session } from "../../auth/context.ts";
import { requireRole } from "../../http/middleware/require-role.ts";
import { body } from "../../http/middleware/validate.ts";
import { timeOffDecision, timeOffRequest } from "./time-off.schema.ts";
import { decide, ownRequests, pendingRequests, requestTimeOff } from "./time-off.service.ts";

export const timeOffRouter = Router();

timeOffRouter.get("/", async (_request, response) => {
  response.json(await ownRequests(session(response)));
});

timeOffRouter.post("/", body(timeOffRequest), async (request, response) => {
  response.status(201).json(await requestTimeOff(session(response), request.body));
});

timeOffRouter.get("/pending", requireRole("manager"), async (_request, response) => {
  response.json(await pendingRequests(session(response)));
});

timeOffRouter.post("/:id/decision", requireRole("manager"), body(timeOffDecision), async (request, response) => {
  response.json(await decide(session(response), request.params.id, request.body.approve));
});
