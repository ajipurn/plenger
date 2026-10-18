import { Router } from "express";
import { z } from "zod";
import { session } from "../../auth/context.ts";
import { body, query } from "../../http/middleware/validate.ts";
import { filterSave } from "./saved-filters.schema.ts";
import { deleteFilter, saveFilter, visibleFilters } from "./saved-filters.service.ts";

export const savedFiltersRouter = Router();

savedFiltersRouter.get("/", async (request, response) => {
  const { view } = query(z.object({ view: z.enum(["time-entries", "tasks", "expenses"]) }), request);
  response.json(await visibleFilters(session(response), view));
});

savedFiltersRouter.post("/", body(filterSave), async (request, response) => {
  response.status(201).json(await saveFilter(session(response), request.body));
});

savedFiltersRouter.delete("/:id", async (request, response) => {
  await deleteFilter(session(response), request.params.id);
  response.status(204).end();
});
