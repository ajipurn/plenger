import { type Response, Router } from "express";
import { session } from "../../auth/context.ts";
import { query } from "../../http/middleware/validate.ts";
import { exportRange } from "./exports.schema.ts";
import { membersCsv, payrollCsv } from "./exports.service.ts";

export const exportsRouter = Router();

function attachment(response: Response, name: string) {
  response.type("text/csv").attachment(name);
}

exportsRouter.get("/payroll.csv", async (request, response) => {
  const range = query(exportRange, request);
  attachment(response, `payroll-${range.from}-${range.to}.csv`);
  response.send(await payrollCsv(session(response), range));
});

exportsRouter.get("/members.csv", async (_request, response) => {
  attachment(response, "members.csv");
  response.send(await membersCsv(session(response)));
});
