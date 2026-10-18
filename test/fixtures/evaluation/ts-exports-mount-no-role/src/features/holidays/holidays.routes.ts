import { Router } from "express";
import { session } from "../../auth/context.ts";
import { requireRole } from "../../http/middleware/require-role.ts";
import { body, query } from "../../http/middleware/validate.ts";
import { holidayCreate, yearQuery } from "./holidays.schema.ts";
import { addHoliday, holidaysIn, removeHoliday } from "./holidays.service.ts";

export const holidaysRouter = Router();

holidaysRouter.get("/", async (request, response) => {
  const { year } = query(yearQuery, request);
  response.json(await holidaysIn(session(response), year));
});

holidaysRouter.post("/", requireRole("admin"), body(holidayCreate), async (request, response) => {
  response.status(201).json(await addHoliday(session(response), request.body));
});

holidaysRouter.delete("/:id", requireRole("admin"), async (request, response) => {
  await removeHoliday(session(response), request.params.id);
  response.status(204).end();
});
