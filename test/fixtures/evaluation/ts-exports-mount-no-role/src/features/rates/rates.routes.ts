import { Router } from "express";
import { session } from "../../auth/context.ts";
import { body } from "../../http/middleware/validate.ts";
import { rateSet } from "./rates.schema.ts";
import { listRates, setRate } from "./rates.service.ts";

export const ratesRouter = Router();

ratesRouter.get("/", async (_request, response) => {
  response.json(await listRates(session(response)));
});

ratesRouter.post("/", body(rateSet), async (request, response) => {
  response.status(201).json(await setRate(session(response), request.body));
});
